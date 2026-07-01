import { randomBytes } from "node:crypto";
import { Agent, type AgentOptions } from "./agent";
import { appendSubagentMessages } from "./session";
import type { LLM, Message, Tool } from "./types";

// 第 15/16/17 步:子 agent —— 把一件事甩给一个【上下文隔离】的子 agent 去跑,只收回结论。
//
// 核心叙事(和本仓库一贯做法一致):子 agent 就是又一个【普通 Tool】,`Agent` 类零改动。
// 本文件抽出一个共享核心 runSubagent(),其上派生两个薄工具:
//   - dispatch_agent(第15/16步):派独立子任务,收回结论;
//   - critic(第17步):请一个【对抗性审查者】审查产出,收回结构化裁定。见 docs/15~17、ADR-0001~0003。
//
// 三个「隔离」是价值所在:上下文隔离(只见 prompt+自身 system)、预算隔离(自己的 maxSteps)、
// 存档隔离(完整历史另存 .sessions/<主id>/agents/,主流水只留结论)。

export const DISPATCH_TOOL_NAME = "dispatch_agent";
export const CRITIC_TOOL_NAME = "critic";

// 子 agent 的独立步数预算(与主 agent 互不影响)。默认 25,可用 AGENT_SUBAGENT_MAX_STEPS 覆盖。
const SUBAGENT_MAX_STEPS = Number(process.env.AGENT_SUBAGENT_MAX_STEPS) || 25;

// dispatch 子 agent 的系统提示:强调它【看不到主对话】,背景都在任务描述里、结论要能独立看懂。
export const SUBAGENT_SYSTEM =
  "你是一个自主子 agent,被主 agent 交办一个独立、边界清晰的子任务。\n" +
  "你【看不到】主对话历史,完成任务所需的全部背景都已写在下面的任务描述里。\n" +
  "请自行使用工具把任务做完,最后用简洁的文字给出【结论】——" +
  "主 agent 只会收到你最后这段文字、看不到你的中间过程,所以结论必须能独立看懂。";

// critic(审查者)的系统提示:对抗性、亲自查验、只查不改、按固定格式输出裁定。
export const CRITIC_SYSTEM =
  "你是一个对抗性审查者(critic),被主 agent 请来审查一份产出。\n" +
  "你【看不到】主对话历史 —— 要审的【原始任务】和【产出结果】都已写在下面的输入里" +
  "(只给结果不给任务无法判对错:给「2」却不知问的是不是「1+1」)。\n" +
  "职责是【挑出问题】而非附和。有可查的实物(代码/文件)就【亲自核对】:读文件、grep、跑测试," +
  "别只信一面之词;没有实物时,就对照任务与标准审查文本本身。\n" +
  "你【只审查、绝不修改】任何文件或状态;shell 仅用于只读查验与跑测试。\n" +
  "最后【只输出】这段裁定,严格按格式:\n" +
  "裁定：通过 / 不通过\n" +
  "问题：\n" +
  "  [严重] …(阻断性:结果错 / 不满足硬性要求 / 测试失败)\n" +
  "  [次要] …(不影响正确性的改进项)\n" +
  "建议：一句话下一步(如「先修严重项再复审」;无问题则「可交付」)";

// 子 agent 启动的类型,供 CLI 区分显示(「派出子 agent」vs「请 critic 审查」)。
export type SubKind = "dispatch" | "critic";

export interface SubagentDeps {
  llm: LLM;
  // 取「当前完整工具集」(含 MCP 热重载后的);各工具在此基础上按需过滤。
  getTools: () => Tool[];
  // 取当前主会话 id(闭包读 let 变量,/new 后自动切目录)。
  getSessionId: () => string;
  // 危险工具审批:透传主 agent 的同一个回调(主/子共享,见 docs/15)。
  onApprove?: AgentOptions["onApprove"];
  // 子 agent 启动(带短 id + prompt + 类型):供 CLI 在主层打「派出子 agent / 请 critic 审查」。
  onSubStart?: (id: string, prompt: string, kind: SubKind) => void;
  // 过程回调(带短 id):供 CLI 按 id 上色 + 打灰度块前缀;并行据此分辨来源(docs/16)。
  onSubToolCall?: (
    id: string,
    call: { name: string; input: Record<string, unknown> },
  ) => void;
  onSubToolResult?: (
    id: string,
    result: { name: string; content: string; isError: boolean },
  ) => void;
  // 覆盖子 agent 步数上限(测试用);默认 SUBAGENT_MAX_STEPS。
  maxSteps?: number;
}

// 随机短 id(6 位十六进制):天然唯一、并发也不撞,无需计数器。用作存档名/显示前缀/配色锚点。
function allocSubagentId(): string {
  return randomBytes(3).toString("hex");
}

// Agent 撞满 maxSteps 时抛的错(见 agent.ts)。据此识别「用尽预算」,做优雅收尾而非硬失败。
function isStepLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("超过最大工具调用步数");
}

// 用尽步数预算时的【收尾】:不再给工具,让子 agent 基于现有历史直接给出阶段性结论。
async function finalizeOnBudget(
  llm: LLM,
  system: string,
  history: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const it = llm.stream(history, { system, signal }); // 不传 tools → 只能汇成文字
  let text = "";
  let step = await it.next();
  while (!step.done) {
    text += step.value;
    step = await it.next();
  }
  if (text) return text;
  return step.value.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

// 统计「干活步数」:发起过【非辅助】tool_use 的 assistant 轮数(口径同主 agent)。
function countWorkSteps(history: Message[], tools: Tool[]): number {
  let n = 0;
  for (const m of history) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const did = m.content.some(
      (b) =>
        b.type === "tool_use" &&
        !tools.find((t) => t.name === b.name)?.auxiliary,
    );
    if (did) n++;
  }
  return n;
}

interface SubResult {
  id: string;
  conclusion: string;
  steps: number;
  truncated: boolean;
  usedTools: string[];
}

// 共享核心:起一个隔离子 agent、跑到结束(含优雅收尾)、落档,返回结论 + 元信息。
// dispatch_agent 与 critic 都基于它,只差 system / tools / prompt / kind。
async function runSubagent(
  deps: SubagentDeps,
  args: { system: string; tools: Tool[]; prompt: string; kind: SubKind },
  signal?: AbortSignal,
): Promise<SubResult> {
  const { llm, getSessionId, onApprove } = deps;
  const { system, tools, prompt, kind } = args;

  const mainId = getSessionId();
  const id = allocSubagentId();
  deps.onSubStart?.(id, prompt, kind);
  const usedTools = new Set<string>();

  const sub = new Agent(llm, {
    system,
    tools,
    maxSteps: deps.maxSteps ?? SUBAGENT_MAX_STEPS, // 预算隔离
    onApprove, // 审批透传:主/子共享
    onTurnComplete: (added) => appendSubagentMessages(mainId, id, added), // 存档
    onToolCall: (c) => {
      usedTools.add(c.name);
      deps.onSubToolCall?.(id, c);
    },
    onToolResult: (r) => deps.onSubToolResult?.(id, r),
  });

  // signal 透传:中断时 sub.send 先封口再上抛;这里对中断不吞,交主 agent 统一封口。
  let conclusion = "";
  let truncated = false;
  try {
    conclusion = (await sub.send(prompt, { signal })).trim();
  } catch (err) {
    if (signal?.aborted) throw err; // 用户中断:照旧上抛
    if (!isStepLimitError(err)) throw err; // 其它错误:如实上抛 → is_error
    // 用尽步数预算:不硬失败、不丢工作,收尾给出阶段性结论,并手动落档(send 抛了没走 onTurnComplete)。
    truncated = true;
    conclusion = (await finalizeOnBudget(llm, system, sub.getHistory(), signal)).trim();
    appendSubagentMessages(mainId, id, [
      ...sub.getHistory(),
      { role: "assistant", content: conclusion },
    ]);
  }

  if (!conclusion) {
    throw new Error(`子 agent ${id} 未产出结论(工具连续失败或收尾为空)`);
  }

  return {
    id,
    conclusion,
    steps: countWorkSteps(sub.getHistory(), tools),
    truncated,
    usedTools: [...usedTools],
  };
}

// ============ dispatch_agent:派独立子任务 ============
export function createDispatchAgentTool(deps: SubagentDeps): Tool {
  return {
    name: DISPATCH_TOOL_NAME,
    description:
      "把一个【独立、边界清晰】的子任务交给一个上下文隔离的子 agent 完成,只收回它的结论。" +
      "适合会产生大量中间过程的子任务(如「读这若干文件并总结」「调研某个库的用法」)——" +
      "让这些过程留在子 agent 里、不占用你自己的上下文。\n" +
      "⚠️ 关键:子 agent【看不到】当前对话,你必须把它完成任务所需的【全部背景】写进 prompt" +
      "(不能说「像刚才那样」「用上面提到的文件」——它读不到)。子 agent 无法再派子 agent。",
    dangerous: false,
    concurrent: true, // 可并行:一轮派多个子 agent 时并发执行(见 docs/16)
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "交给子 agent 的完整任务描述,必须自带所有背景(子 agent 看不到当前对话)。",
        },
      },
      required: ["prompt"],
    },
    run: async (input, ctx) => {
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new Error("dispatch_agent 需要非空的 prompt");
      // 禁递归:子 agent 拿「全套 − dispatch_agent 自己」(critic 留着,子 agent 也可请审查)。
      const tools = deps.getTools().filter((t) => t.name !== DISPATCH_TOOL_NAME);
      const r = await runSubagent(
        deps,
        { system: SUBAGENT_SYSTEM, tools, prompt, kind: "dispatch" },
        ctx?.signal,
      );
      const note = r.truncated ? "｜⚠️达步数上限,以下为阶段性结论" : "";
      return `${r.conclusion}\n\n（子 agent ${r.id}｜${r.steps} 步${note}｜用过工具: ${r.usedTools.join("、") || "无"}）`;
    },
  };
}

// ============ critic:请对抗性审查者审查产出(第17步)============
export function createCriticTool(deps: SubagentDeps): Tool {
  return {
    name: CRITIC_TOOL_NAME,
    description:
      "请一个【上下文隔离的对抗性审查者】审查你的产出,收回结构化裁定(通过/不通过 + 分级问题 + 建议)。" +
      "重要 / 易错 / 有可验证产物的任务完成后用它自查;平凡确定的操作(如 ls、看时间、单次读取)【不必】用。\n" +
      "⚠️ 关键:审查者【看不到】当前对话,你必须【同时】提供 task(原始任务/目标)和 output(产出结果)——" +
      "只给 output 无法判对错(给「2」却不知问的是不是「1+1」)。有代码/文件产物时在 artifacts 里给出路径线索," +
      "审查者会亲自读代码、跑测试来核对。",
    dangerous: false,
    concurrent: true, // 可并行:同时审多份产出
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "原始任务 / 目标 / 要解决的问题(必填,否则无法判对错)。",
        },
        output: {
          type: "string",
          description: "要审查的产出结果:答案文本,或「改了哪些文件、做了什么」的说明(必填)。",
        },
        criteria: {
          type: "string",
          description: "可选:具体验收标准(如「必须过测试」「要覆盖 X 情况」)。",
        },
        artifacts: {
          type: "string",
          description: "可选:产物位置线索(文件路径等),供审查者顺着去读代码/跑测试。",
        },
      },
      required: ["task", "output"],
    },
    run: async (input, ctx) => {
      const task = String(input.task ?? "").trim();
      const output = String(input.output ?? "").trim();
      if (!task || !output) {
        throw new Error(
          "critic 需要【同时】提供 task(原始任务)和 output(产出结果)——只给其一无法判对错",
        );
      }
      const criteria = String(input.criteria ?? "").trim();
      const artifacts = String(input.artifacts ?? "").trim();
      const prompt = [
        `【原始任务】\n${task}`,
        `【产出结果】\n${output}`,
        criteria && `【验收标准】\n${criteria}`,
        artifacts && `【产物位置】\n${artifacts}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      // 审查者工具集:全套 −{write_file, dispatch_agent, critic 自己} —— 只查不改、不派活、不套娃。
      const excluded = new Set(["write_file", DISPATCH_TOOL_NAME, CRITIC_TOOL_NAME]);
      const tools = deps.getTools().filter((t) => !excluded.has(t.name));
      const r = await runSubagent(
        deps,
        { system: CRITIC_SYSTEM, tools, prompt, kind: "critic" },
        ctx?.signal,
      );
      const note = r.truncated ? "｜⚠️达步数上限,裁定可能不完整" : "";
      return `${r.conclusion}\n\n（critic ${r.id}｜${r.steps} 步${note}）`;
    },
  };
}
