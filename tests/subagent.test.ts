import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import {
  DISPATCH_TOOL_NAME,
  SUBAGENT_SYSTEM,
  createDispatchAgentTool,
} from "../src/subagent";
import type { LLMResponse, Message, Tool } from "../src/types";
import { FakeLLM } from "./fake-llm";

// 全程离线:用临时目录接管子 agent 存档,避免污染真实 .sessions/。
const TMP = mkdtempSync(join(tmpdir(), "subagent-test-"));
process.env.AGENT_SESSIONS_DIR = TMP;
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// 一个最小的「干活」子工具,供子 agent 调用(非辅助,会计入步数)。
const echoTool: Tool = {
  name: "echo",
  description: "回显输入的 text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  run: (input) => `echo:${String(input.text ?? "")}`,
};

// 造 tool_use / 组装 dispatch_agent 工具的公共脚手架。
function toolUse(id: string, name: string, input: Record<string, unknown>): LLMResponse {
  return { stopReason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}

// 组装一套「主 agent + dispatch_agent(禁递归)」。getTools 返回全集(含 dispatch 自己),
// 由工具内部剔除 —— 正是 CLI 的接线方式。
function build(
  llm: FakeLLM,
  opts: { sessionId?: string; maxSteps?: number; childTools?: Tool[] } = {},
) {
  const childTools = opts.childTools ?? [echoTool];
  let dispatchTool: Tool;
  const getTools = () => [dispatchTool, ...childTools];
  dispatchTool = createDispatchAgentTool({
    llm,
    getTools,
    getSessionId: () => opts.sessionId ?? "sess-test",
    maxSteps: opts.maxSteps,
  });
  const agent = new Agent(llm, { tools: [dispatchTool, ...childTools] });
  return { agent, dispatchTool };
}

describe("dispatch_agent:上下文隔离 + 只收回结论", () => {
  test("主 agent 派活 → 子 agent 多步跑完 → 结论回到主历史", async () => {
    let mainDispatched = false;
    let subDidTool = false;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) {
        // 子 agent:先调一次 echo,再给结论。
        if (!subDidTool) {
          subDidTool = true;
          return toolUse("s1", "echo", { text: "hi" });
        }
        return "子任务完成:结论 X";
      }
      // 主 agent:先派活,拿到结论后给最终答复。
      if (!mainDispatched) {
        mainDispatched = true;
        return toolUse("m1", DISPATCH_TOOL_NAME, { prompt: "去做子任务,背景齐全" });
      }
      return "主 agent:已根据子结论作答";
    });

    const { agent } = build(llm);
    const reply = await agent.send("帮我干个独立子任务");
    expect(reply).toBe("主 agent:已根据子结论作答");

    // 主历史里,dispatch_agent 的 tool_result 应含子结论 + 过程元信息;但【不含】子 agent
    // 内部的 echo 调用(隔离:中间过程不进主上下文)。
    const results = agent
      .getHistory()
      .filter((m): m is Message & { content: Extract<Message["content"], object> } =>
        Array.isArray(m.content),
      )
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    const dispatchResult = results.find((b) => b.tool_use_id === "m1")!;
    expect(dispatchResult.content).toContain("结论 X");
    expect(dispatchResult.content).toContain("子 agent#1");
    expect(dispatchResult.content).toContain("echo"); // 元信息里报告用过 echo
    // 主历史里不该出现子 agent 的 echo 的 tool_use。
    const mainHasEcho = agent
      .getHistory()
      .some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_use" && b.name === "echo"),
      );
    expect(mainHasEcho).toBe(false);
  });

  test("上下文隔离:子 agent 只看到 prompt,看不到主对话历史", async () => {
    let mainDispatched = false;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) return "子结论";
      if (!mainDispatched) {
        mainDispatched = true;
        return toolUse("m1", DISPATCH_TOOL_NAME, { prompt: "只带这段背景" });
      }
      return "主答复";
    });

    const { agent } = build(llm);
    await agent.send("主对话里的敏感上下文");

    // 找到子 agent 的首次调用(system = SUBAGENT_SYSTEM):它的 messages 只有那条 prompt,
    // 完全没有主对话的内容。
    const subFirstCall = llm.calls.find((c) => c.system === SUBAGENT_SYSTEM)!;
    expect(subFirstCall.messages).toHaveLength(1);
    expect(subFirstCall.messages[0]!.content).toBe("只带这段背景");
    // 反向确认:主对话文本没泄漏进子 agent 上下文。
    const leaked = JSON.stringify(subFirstCall.messages).includes("敏感上下文");
    expect(leaked).toBe(false);
  });

  test("禁递归:子 agent 的工具集不含 dispatch_agent(但含子工具)", async () => {
    let mainDispatched = false;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) return "子结论";
      if (!mainDispatched) {
        mainDispatched = true;
        return toolUse("m1", DISPATCH_TOOL_NAME, { prompt: "p" });
      }
      return "主答复";
    });

    const { agent } = build(llm);
    await agent.send("go");

    const subCall = llm.calls.find((c) => c.system === SUBAGENT_SYSTEM)!;
    const names = (subCall.tools ?? []).map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).not.toContain(DISPATCH_TOOL_NAME); // 子 agent 无法再派子 agent
  });
});

describe("dispatch_agent:存档与失败语义", () => {
  test("子 agent 完整历史落盘到 .sessions/<主id>/agents/agent-1.jsonl", async () => {
    let mainDispatched = false;
    let subDidTool = false;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) {
        if (!subDidTool) {
          subDidTool = true;
          return toolUse("s1", "echo", { text: "存档我" });
        }
        return "结论:已存档";
      }
      if (!mainDispatched) {
        mainDispatched = true;
        return toolUse("m1", DISPATCH_TOOL_NAME, { prompt: "写点东西" });
      }
      return "主答复";
    });

    const { agent } = build(llm, { sessionId: "sess-archive" });
    await agent.send("go");

    const file = join(TMP, "sess-archive", "agents", "agent-1.jsonl");
    expect(existsSync(file)).toBe(true);
    const dump = readFileSync(file, "utf-8");
    // 子档案里应能看到子 agent 的 prompt、echo 调用与结论 —— 完整过程都在这。
    expect(dump).toContain("写点东西");
    expect(dump).toContain("echo");
    expect(dump).toContain("已存档");
    // 而主流水(主上下文)里不含 echo(隔离,前一个 describe 已验证方向)。
  });

  test("子档案序号递增:第二次派活 → agent-2.jsonl", async () => {
    // 主 agent 连派两次子 agent,各自跑完给结论。
    let mainStep = 0;
    const subGiven = new Set<number>();
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) {
        // 每个子 agent 直接给结论(0 步干活也算一次派活)。
        return "子结论";
      }
      mainStep++;
      if (mainStep === 1) return toolUse("d1", DISPATCH_TOOL_NAME, { prompt: "第一次" });
      if (mainStep === 2) return toolUse("d2", DISPATCH_TOOL_NAME, { prompt: "第二次" });
      return "两次都派完了";
    });

    const { agent } = build(llm, { sessionId: "sess-seq" });
    await agent.send("派两次");
    expect(existsSync(join(TMP, "sess-seq", "agents", "agent-1.jsonl"))).toBe(true);
    expect(existsSync(join(TMP, "sess-seq", "agents", "agent-2.jsonl"))).toBe(true);
  });

  test("子 agent 撞满步数 → 收尾给出【阶段性结论】(不硬失败、不丢工作)", async () => {
    let mainDispatched = false;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) {
        // 有工具时:一直调 echo(永不主动收敛)→ 撞满步数。
        // 收尾调用【不带工具】(opts.tools 为空)→ 给出阶段性结论。
        if (!opts.tools || opts.tools.length === 0) return "阶段性结论:已处理前几项";
        return toolUse(`s${llm.calls.length}`, "echo", { text: "x" });
      }
      if (!mainDispatched) {
        mainDispatched = true;
        return toolUse("m1", DISPATCH_TOOL_NAME, { prompt: "大任务" });
      }
      return "主答复";
    });

    const { agent } = build(llm, { sessionId: "sess-finalize", maxSteps: 2 });
    await agent.send("go");

    const block = agent
      .getHistory()
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_result" && b.tool_use_id === "m1");
    // 关键:不是 is_error,而是带阶段性结论正常回传 —— 主 agent 能接着往下走。
    const isErr = block && block.type === "tool_result" ? block.is_error : true;
    expect(isErr).toBeFalsy();
    const content = block && block.type === "tool_result" ? String(block.content) : "";
    expect(content).toContain("阶段性结论:已处理前几项");
    expect(content).toContain("阶段性结论"); // 元信息里的截断提示
    // 收尾路径也把子档案落了盘。
    expect(existsSync(join(TMP, "sess-finalize", "agents", "agent-1.jsonl"))).toBe(true);
  });

  test("子 agent 连收尾都无文本 → 仍返回 is_error 给主 agent", async () => {
    let mainDispatched = false;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      // 子 agent 永远只调 echo、永不给文本 → 撞满 maxSteps → sub.send 抛错。
      if (opts.system === SUBAGENT_SYSTEM) {
        return toolUse(`s${llm.calls.length}`, "echo", { text: "x" });
      }
      if (!mainDispatched) {
        mainDispatched = true;
        return toolUse("m1", DISPATCH_TOOL_NAME, { prompt: "死循环子任务" });
      }
      return "主 agent:注意到子任务失败了";
    });

    const { agent } = build(llm, { sessionId: "sess-fail", maxSteps: 2 });
    const reply = await agent.send("go");
    expect(reply).toBe("主 agent:注意到子任务失败了");

    // dispatch_agent 的 tool_result 应是 is_error(子任务失败被如实上报,而非静默)。
    const errBlock = agent
      .getHistory()
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_result" && b.tool_use_id === "m1");
    expect(errBlock && errBlock.type === "tool_result" ? errBlock.is_error : false).toBe(true);
  });
});
