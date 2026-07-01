import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import {
  createCriticTool,
  createDispatchAgentTool,
  CRITIC_SYSTEM,
  CRITIC_TOOL_NAME,
  DISPATCH_TOOL_NAME,
} from "../src/subagent";
import { defaultTools } from "../src/tools";
import type { LLMResponse, Tool } from "../src/types";
import { FakeLLM } from "./fake-llm";

const TMP = mkdtempSync(join(tmpdir(), "critic-test-"));
process.env.AGENT_SESSIONS_DIR = TMP;
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function build(
  llm: FakeLLM,
  opts: { sessionId?: string; maxSteps?: number; childTools?: Tool[] } = {},
) {
  const childTools = opts.childTools ?? defaultTools;
  let dispatchTool: Tool;
  let criticTool: Tool;
  const getTools = () => [dispatchTool, criticTool, ...childTools];
  const deps = {
    llm,
    getTools,
    getSessionId: () => opts.sessionId ?? "sess-critic",
    maxSteps: opts.maxSteps,
  };
  dispatchTool = createDispatchAgentTool(deps);
  criticTool = createCriticTool(deps);
  const agent = new Agent(llm, { tools: [dispatchTool, criticTool, ...childTools] });
  return { agent };
}

const toolResult = (history: ReturnType<Agent["getHistory"]>, id: string) =>
  history
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result" && b.tool_use_id === id);

describe("critic:结构化裁定 + 只读查验工具集", () => {
  test("返回裁定进主历史;子 agent 工具集排除 写/派活/自审、保留只读查验", async () => {
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === CRITIC_SYSTEM) {
        return "裁定：不通过\n问题：\n  [严重] 缺边界处理\n建议：先修严重项再复审";
      }
      const done = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
      );
      if (done) return "已按裁定处理";
      return {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "c1", name: CRITIC_TOOL_NAME, input: { task: "1+1=?", output: "2" } },
        ],
      };
    });

    const { agent } = build(llm);
    expect(await agent.send("审一下")).toBe("已按裁定处理");

    const res = toolResult(agent.getHistory(), "c1");
    expect(res && res.type === "tool_result" ? String(res.content) : "").toContain("裁定：不通过");

    // critic 子 agent 拿到的工具集
    const criticCall = llm.calls.find((c) => c.system === CRITIC_SYSTEM)!;
    const names = (criticCall.tools ?? []).map((t) => t.name);
    expect(names).toContain("read_file"); // 能读代码
    expect(names).toContain("shell"); // 能跑测试/grep
    expect(names).not.toContain("write_file"); // 不能改文件
    expect(names).not.toContain(DISPATCH_TOOL_NAME); // 不能派活
    expect(names).not.toContain(CRITIC_TOOL_NAME); // 不能自审套娃
  });

  test("缺 task → is_error(只给结果无法判对错),且不真正起 critic 子 agent", async () => {
    let mainStep = 0;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === CRITIC_SYSTEM) return "裁定：通过"; // 不该被调到
      mainStep++;
      if (mainStep === 1) {
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "c1", name: CRITIC_TOOL_NAME, input: { output: "2" } }],
        };
      }
      return "收到错误";
    });

    const { agent } = build(llm, { sessionId: "sess-critic-badinput" });
    await agent.send("go");

    const res = toolResult(agent.getHistory(), "c1");
    expect(res && res.type === "tool_result" ? res.is_error : false).toBe(true);
    expect(res && res.type === "tool_result" ? String(res.content) : "").toContain("task");
    // 校验在起子 agent 前就挡下了 → 没有 CRITIC_SYSTEM 调用
    expect(llm.calls.some((c) => c.system === CRITIC_SYSTEM)).toBe(false);
  });

  test("grounded:critic 会实际调用查验工具核对,而非只看说法", async () => {
    let inspected = false;
    const inspectTool: Tool = {
      name: "inspect",
      description: "只读查验",
      inputSchema: { type: "object", properties: {} },
      run: () => {
        inspected = true;
        return "查到:边界未处理";
      },
    };
    let subDidTool = false;
    let mainStep = 0;
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === CRITIC_SYSTEM) {
        if (!subDidTool) {
          subDidTool = true; // critic 先亲自查
          return { stopReason: "tool_use", content: [{ type: "tool_use", id: "i1", name: "inspect", input: {} }] };
        }
        return "裁定：不通过\n问题：\n  [严重] 边界未处理\n建议：修";
      }
      mainStep++;
      if (mainStep === 1) {
        return {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: CRITIC_TOOL_NAME,
              input: { task: "实现 X", output: "改了 a.ts", artifacts: "a.ts" },
            },
          ],
        };
      }
      return "已修";
    });

    const { agent } = build(llm, { sessionId: "sess-critic-grounded", childTools: [inspectTool] });
    await agent.send("go");
    expect(inspected).toBe(true); // critic 亲自查了实物,不是走过场
  });
});
