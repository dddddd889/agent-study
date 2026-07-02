import { randomBytes } from "node:crypto";
import { Agent, type AgentOptions } from "./agent";
import {
  DEFAULT_ROLE,
  promptRoleNames,
  resolveRole,
  ROLES,
  type Role,
} from "./roles";
import type { PermissionMode } from "./permission";
import { appendSubagentMessages } from "./session";
import type { LLM, Message, Tool, Usage } from "./types";

// 第 15/16/17/18 步:子 agent —— 把一件事甩给一个【上下文隔离】的子 agent,只收回结论。
//
// 核心叙事:子 agent 就是又一个【普通 Tool】,`Agent` 类零改动。共享核心 runSubagent() 之上派生:
//   - dispatch_agent(第15/16步 + 第18步 agent_type):按角色派独立子任务,收回结论;
//   - critic(第17步):请对抗性审查者审查产出,收回结构化裁定。
// 角色(system + 工具裁法 + 预算)集中在 src/roles.ts 注册表。见 docs/15~18、ADR-0001~0004。

export const DISPATCH_TOOL_NAME = "dispatch_agent";
export const CRITIC_TOOL_NAME = "critic";

// 子 agent 的独立步数预算(与主 agent 互不影响)。默认 25,可用 AGENT_SUBAGENT_MAX_STEPS 覆盖。
const SUBAGENT_MAX_STEPS = Number(process.env.AGENT_SUBAGENT_MAX_STEPS) || 25;

// 为测试/兼容 re-export 常用角色的 system(注册表是真相)。
export const SUBAGENT_SYSTEM = ROLES[DEFAULT_ROLE]!.system;
export const CRITIC_SYSTEM = ROLES.critic!.system;

export interface SubagentDeps {
  llm: LLM;
  // 取「当前完整工具集」(含 MCP 热重载后的);各角色在此基础上按基线 + exclude 裁剪。
  getTools: () => Tool[];
  // 取当前主会话 id(闭包读 let 变量,/new 后自动切目录)。
  getSessionId: () => string;
  // 危险工具审批:透传主 agent 的同一个回调(主/子共享,见 docs/15)。
  onApprove?: AgentOptions["onApprove"];
  // 子 agent 启动(带短 id + prompt + 角色名):供 CLI 在主层打「派出 <角色> 子 agent / 请 critic 审查」。
  onSubStart?: (id: string, prompt: string, roleType: string) => void;
  // 过程回调(带短 id):供 CLI 按 id 上色 + 打灰度块前缀;并行据此分辨来源(docs/16)。
  onSubToolCall?: (
    id: string,
    call: { name: string; input: Record<string, unknown> },
  ) => void;
  onSubToolResult?: (
    id: string,
    result: { name: string; content: string; isError: boolean },
  ) => void;
  // 覆盖子 agent 步数上限(测试用);优先级高于角色的 maxSteps。
  maxSteps?: number;
  // 子 agent 跑完回传它的短 id + 总 token 用量(含缓存读写),供主层【按 id】分列(第22步)。
  onSubUsage?: (id: string, usage: Usage) => void;
  // 取主 agent 当前权限模式:子 agent 派生时【继承】它(第24步)。不提供则子 agent 自读 AGENT_MODE。
  getMode?: () => PermissionMode;
}

// 随机短 id(6 位十六进制):天然唯一、并发也不撞。用作存档名/显示前缀/配色锚点。
function allocSubagentId(): string {
  return randomBytes(3).toString("hex");
}

// Agent 撞满 maxSteps 时抛的错。据此识别「用尽预算」,做优雅收尾而非硬失败。
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

// 按角色裁工具集:基线剔除两个会起子 agent 的工具(禁嵌套),再按角色 exclude 收紧。见 ADR-0004。
function toolsForRole(getTools: () => Tool[], role: Role): Tool[] {
  const drop = new Set<string>([
    DISPATCH_TOOL_NAME,
    CRITIC_TOOL_NAME,
    ...(role.exclude ?? []),
  ]);
  return getTools().filter((t) => !drop.has(t.name));
}

interface SubResult {
  id: string;
  conclusion: string;
  steps: number;
  truncated: boolean;
  usedTools: string[];
}

// 共享核心:按角色起一个隔离子 agent、跑到结束(含优雅收尾)、落档,返回结论 + 元信息。
async function runSubagent(
  deps: SubagentDeps,
  args: { roleType: string; role: Role; prompt: string },
  signal?: AbortSignal,
): Promise<SubResult> {
  const { llm, getSessionId, onApprove } = deps;
  const { roleType, role, prompt } = args;

  const mainId = getSessionId();
  const id = allocSubagentId();
  deps.onSubStart?.(id, prompt, roleType);
  const tools = toolsForRole(deps.getTools, role);
  const usedTools = new Set<string>();

  const sub = new Agent(llm, {
    system: role.system,
    tools,
    maxSteps: deps.maxSteps ?? role.maxSteps ?? SUBAGENT_MAX_STEPS, // 预算隔离
    mode: deps.getMode?.(), // 继承主 agent 当前权限模式(plan 下子 agent 也只读)
    onApprove, // 审批透传:主/子共享
    onTurnComplete: (added) => appendSubagentMessages(mainId, id, added), // 存档
    onToolCall: (c) => {
      usedTools.add(c.name);
      deps.onSubToolCall?.(id, c);
    },
    onToolResult: (r) => deps.onSubToolResult?.(id, r),
  });

  let conclusion = "";
  let truncated = false;
  try {
    conclusion = (await sub.send(prompt, { signal })).trim();
  } catch (err) {
    if (signal?.aborted) throw err; // 用户中断:照旧上抛
    if (!isStepLimitError(err)) throw err; // 其它错误:如实上抛 → is_error
    // 用尽步数预算:不硬失败、不丢工作,收尾给出阶段性结论,并手动落档。
    truncated = true;
    conclusion = (await finalizeOnBudget(llm, role.system, sub.getHistory(), signal)).trim();
    appendSubagentMessages(mainId, id, [
      ...sub.getHistory(),
      { role: "assistant", content: conclusion },
    ]);
  }

  // 回传这个子 agent 的总 token 用量(含它内部的摘要),供主层归到「子 agent」桶。
  // 注:撞满步数走 finalizeOnBudget 那次直连 llm 的用量未计入(边角,忽略)。
  deps.onSubUsage?.(id, sub.totalUsage());

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

// ============ dispatch_agent:按角色(agent_type)派独立子任务 ============
export function createDispatchAgentTool(deps: SubagentDeps): Tool {
  const roleList = promptRoleNames()
    .map((n) => `  - ${n}：${ROLES[n]!.description}`)
    .join("\n");
  return {
    name: DISPATCH_TOOL_NAME,
    description:
      "把一个【独立、边界清晰】的子任务交给一个上下文隔离的子 agent 完成,只收回它的结论。" +
      "让大量中间过程留在子 agent 里、不占用你自己的上下文。\n" +
      "用 agent_type 选角色(不填默认 general):\n" +
      roleList +
      "\n⚠️ 子 agent【看不到】当前对话,必须把完成任务所需的【全部背景】写进 prompt。" +
      "子 agent 无法再派子 agent、也不能请 critic。",
    category: "read", // 派活本身无副作用(子 agent 内部工具各自再过模式);免审批
    concurrent: true, // 可并行:一轮派多个子 agent 时并发执行(见 docs/16)
    inputSchema: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          enum: promptRoleNames(),
          description: "子 agent 角色,默认 general(通用干活)。",
        },
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
      // 解析角色:只接受 prompt 式;未知/非 prompt(如误传 critic)→ 回退 general。
      const asked = input.agent_type ? String(input.agent_type) : DEFAULT_ROLE;
      const roleType =
        ROLES[asked]?.kind === "prompt" ? asked : DEFAULT_ROLE;
      const role = resolveRole(roleType);

      const r = await runSubagent(deps, { roleType, role, prompt }, ctx?.signal);
      const note = r.truncated ? "｜⚠️达步数上限,以下为阶段性结论" : "";
      return `${r.conclusion}\n\n（子 agent ${r.id}[${roleType}]｜${r.steps} 步${note}｜用过工具: ${r.usedTools.join("、") || "无"}）`;
    },
  };
}

// ============ critic:请对抗性审查者审查产出(第17步,配置从注册表读)============
export function createCriticTool(deps: SubagentDeps): Tool {
  return {
    name: CRITIC_TOOL_NAME,
    description:
      "请一个【上下文隔离的对抗性审查者】审查你的产出,收回结构化裁定(通过/不通过 + 分级问题 + 建议)。" +
      "重要 / 易错 / 有可验证产物的任务完成后用它自查;平凡确定的操作(如 ls、看时间、单次读取)【不必】用。\n" +
      "⚠️ 关键:审查者【看不到】当前对话,你必须【同时】提供 task(原始任务/目标)和 output(产出结果)——" +
      "只给 output 无法判对错(给「2」却不知问的是不是「1+1」)。有代码/文件产物时在 artifacts 里给出路径线索。",
    category: "read", // 请审查本身无副作用(审查者只读查验);免审批
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

      const r = await runSubagent(
        deps,
        { roleType: "critic", role: ROLES.critic!, prompt },
        ctx?.signal,
      );
      const note = r.truncated ? "｜⚠️达步数上限,裁定可能不完整" : "";
      return `${r.conclusion}\n\n（critic ${r.id}｜${r.steps} 步${note}）`;
    },
  };
}
