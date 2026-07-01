import { Agent, type AgentOptions } from "./agent";
import { appendSubagentMessages, nextSubagentIndex } from "./session";
import type { LLM, Message, Tool } from "./types";

// 第 15 步:子 agent —— 把一个【独立子任务】甩给一个【上下文隔离】的子 agent 去跑,只收回结论。
//
// 核心叙事(和本仓库一贯做法一致):子 agent 就是又一个【普通 Tool】。
// `Agent` 类零改动 —— dispatch_agent.run() 内部 new 一个新的 Agent、喂一段 prompt、
// 跑完它自己的工具循环,把最终文本当 tool_result 返回。详见 docs/15 与 docs/adr/0001。
//
// 三个「隔离」是这一步的全部价值:
//   1. 上下文隔离:子 agent 只见 prompt + 自身 system,看不到主对话历史;
//   2. 预算隔离:子 agent 有自己的 maxSteps / maxContextTokens,主 agent 花 1 步派活即可;
//   3. 存档隔离:子 agent 完整历史另存到 .sessions/<主id>/agents/,主流水只留结论。

export const DISPATCH_TOOL_NAME = "dispatch_agent";

// 子 agent 的独立步数预算(与主 agent 互不影响)。见 docs/14 结尾埋的伏笔。
// 子 agent 常承接一整个子任务(读很多文件 / 多步 shell),预算要比主 agent 宽:
// 默认 25,可用 AGENT_SUBAGENT_MAX_STEPS 覆盖。
const SUBAGENT_MAX_STEPS = Number(process.env.AGENT_SUBAGENT_MAX_STEPS) || 25;

// Agent 撞满 maxSteps 时抛的错(见 agent.ts)。据此识别「用尽预算」,做优雅收尾而非硬失败。
function isStepLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("超过最大工具调用步数");
}

// 用尽步数预算时的【收尾】:不再给工具,让子 agent 基于现有历史直接给出阶段性结论,
// 而不是把已经做的十几步工作全丢掉。返回收尾文本(可能为空 → 由调用方兜底)。
async function finalizeOnBudget(
  llm: LLM,
  history: Message[],
  signal?: AbortSignal,
): Promise<string> {
  // 关键:不传 tools —— 模型无法再调工具,只能把目前掌握的信息汇成一段文字。
  const it = llm.stream(history, { system: SUBAGENT_SYSTEM, signal });
  let text = "";
  let step = await it.next();
  while (!step.done) {
    text += step.value;
    step = await it.next();
  }
  if (text) return text;
  // 兜底:若增量为空,从最终响应里抽文本块。
  return step.value.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

// 子 agent 的系统提示。最关键的一句:强调它【看不到主对话】——
// 所需背景都在任务描述里,结论要能被独立看懂。这是隔离模式最反直觉、最易错的点。
export const SUBAGENT_SYSTEM =
  "你是一个自主子 agent,被主 agent 交办一个独立、边界清晰的子任务。\n" +
  "你【看不到】主对话历史,完成任务所需的全部背景都已写在下面的任务描述里。\n" +
  "请自行使用工具把任务做完,最后用简洁的文字给出【结论】——" +
  "主 agent 只会收到你最后这段文字、看不到你的中间过程,所以结论必须能独立看懂。";

export interface DispatchDeps {
  llm: LLM;
  // 取「当前完整工具集」(含 MCP 热重载后的);子 agent 会在此基础上剔除 dispatch_agent 自己。
  getTools: () => Tool[];
  // 取当前主会话 id(闭包读 let 变量,/new 后自动切到新目录)。
  getSessionId: () => string;
  // 危险工具审批:透传主 agent 的同一个回调(主/子共享,见 docs/15)。
  onApprove?: AgentOptions["onApprove"];
  // 子 agent 过程回调(CLI 注入,带 ⤷ 缩进打印);测试可不传。
  onTextDelta?: AgentOptions["onTextDelta"];
  onToolCall?: AgentOptions["onToolCall"];
  onToolResult?: AgentOptions["onToolResult"];
  // 覆盖子 agent 步数上限(测试用);默认 SUBAGENT_MAX_STEPS。
  maxSteps?: number;
}

// 统计子 agent 的「干活步数」:发起过【非辅助】tool_use 的 assistant 轮数(口径同主 agent)。
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

// 造 dispatch_agent 工具。它本身是个再普通不过的 Tool,只是 run() 里跑了一整个子 agent。
export function createDispatchAgentTool(deps: DispatchDeps): Tool {
  const { llm, getTools, getSessionId, onApprove } = deps;
  return {
    name: DISPATCH_TOOL_NAME,
    description:
      "把一个【独立、边界清晰】的子任务交给一个上下文隔离的子 agent 完成,只收回它的结论。" +
      "适合会产生大量中间过程的子任务(如「读这若干文件并总结」「调研某个库的用法」)——" +
      "让这些过程留在子 agent 里、不占用你自己的上下文。\n" +
      "⚠️ 关键:子 agent【看不到】当前对话,你必须把它完成任务所需的【全部背景】写进 prompt" +
      "(不能说「像刚才那样」「用上面提到的文件」——它读不到)。子 agent 无法再派子 agent。",
    dangerous: false, // 自身不碰副作用;真正的副作用在子 agent 内部的具体工具上,那里会走审批
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

      const mainId = getSessionId();
      const index = nextSubagentIndex(mainId);
      // 禁递归:子 agent 拿「全套 − dispatch_agent 自己」;getTools 返回当前全集,自带 MCP。
      const tools = getTools().filter((t) => t.name !== DISPATCH_TOOL_NAME);
      const usedTools = new Set<string>();

      const sub = new Agent(llm, {
        system: SUBAGENT_SYSTEM,
        tools,
        // 预算隔离:子 agent 自己的步数上限,和主 agent 的预算互不侵蚀。
        maxSteps: deps.maxSteps ?? SUBAGENT_MAX_STEPS,
        // 审批透传:主/子共享同一回调与「总是允许」集合。
        onApprove,
        // 存档:子 agent 一整轮(含被中断时的封口)落到 agents/agent-N.jsonl。
        onTurnComplete: (added) => appendSubagentMessages(mainId, index, added),
        onTextDelta: deps.onTextDelta,
        onToolCall: (c) => {
          usedTools.add(c.name);
          deps.onToolCall?.(c);
        },
        onToolResult: deps.onToolResult,
      });

      // signal 透传:一次 Ctrl+C 同时中断子 agent。abort 时 sub.send 会先封口(补取消结果 +
      // 落盘)再【上抛】;这里对中断【不吞】,让异常穿过去交主 agent 的 runTool/send 统一封口。
      let conclusion = "";
      let truncated = false;
      try {
        conclusion = (await sub.send(prompt, { signal: ctx?.signal })).trim();
      } catch (err) {
        if (ctx?.signal?.aborted) throw err; // 用户中断:照旧上抛
        if (!isStepLimitError(err)) throw err; // 其它错误(网络等):如实上抛 → is_error
        // 用尽步数预算:不硬失败、不丢弃已有工作,让子 agent 收尾给出【阶段性结论】。
        truncated = true;
        conclusion = (
          await finalizeOnBudget(llm, sub.getHistory(), ctx?.signal)
        ).trim();
        // 撞满步数这条路径没走 onTurnComplete(send 抛了),手动把完整过程 + 收尾结论落档。
        appendSubagentMessages(mainId, index, [
          ...sub.getHistory(),
          { role: "assistant", content: conclusion },
        ]);
      }

      // 连收尾都没产出文本(工具连续失败等)→ 抛错 = is_error,让主 agent 知道子任务失败。
      if (!conclusion) {
        throw new Error(
          `子 agent#${index} 未产出结论(工具连续失败或收尾为空)`,
        );
      }

      // 结论 + 一小段过程元信息(步数 / 用过的工具),给主 agent 一点点可见度(Q5=A+B)。
      const steps = countWorkSteps(sub.getHistory(), tools);
      const used = [...usedTools].join("、") || "无";
      const note = truncated ? "｜⚠️达步数上限,以下为阶段性结论" : "";
      return `${conclusion}\n\n（子 agent#${index}｜${steps} 步${note}｜用过工具: ${used}）`;
    },
  };
}
