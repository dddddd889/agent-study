import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import {
  DISPATCH_TOOL_NAME,
  SUBAGENT_SYSTEM,
  createDispatchAgentTool,
} from "../src/subagent";
import type { LLMResponse, Tool } from "../src/types";
import { FakeLLM } from "./fake-llm";

const TMP = mkdtempSync(join(tmpdir(), "parallel-test-"));
process.env.AGENT_SESSIONS_DIR = TMP;
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// 一轮吐出 n 个【同名 concurrent 工具】的调用(触发并行);再调一次则给最终文本。
function fanOut(name: string, n: number): FakeLLM {
  let dispatched = false;
  return new FakeLLM((): string | LLMResponse => {
    if (dispatched) return "done";
    dispatched = true;
    return {
      stopReason: "tool_use",
      content: Array.from({ length: n }, (_, i) => ({
        type: "tool_use" as const,
        id: `c${i}`,
        name,
        input: { i },
      })),
    };
  });
}

describe("并行执行(concurrent 工具)", () => {
  test("并发上限生效:同时在飞的数量不超过 maxConcurrency", async () => {
    const flight = { now: 0, max: 0 };
    const slow: Tool = {
      name: "slow",
      description: "",
      concurrent: true,
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        flight.now++;
        flight.max = Math.max(flight.max, flight.now);
        await new Promise((r) => setTimeout(r, 15)); // 拖住,制造重叠
        flight.now--;
        return "ok";
      },
    };
    // 一轮派 6 个,但上限 2 → 任意时刻最多 2 个在飞。
    const agent = new Agent(fanOut("slow", 6), { tools: [slow], maxConcurrency: 2 });
    expect(await agent.send("go")).toBe("done");
    expect(flight.max).toBe(2);
  });

  test("串行回退:混进非 concurrent 工具 → 整轮不并发(在飞恒为 1)", async () => {
    const flight = { now: 0, max: 0 };
    const mk = (name: string, concurrent: boolean): Tool => ({
      name,
      description: "",
      concurrent,
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        flight.now++;
        flight.max = Math.max(flight.max, flight.now);
        await new Promise((r) => setTimeout(r, 10));
        flight.now--;
        return "ok";
      },
    });
    // 一轮里两个 concurrent + 一个非 concurrent → 规则要求「全并发才并行」,故退回串行。
    let dispatched = false;
    const llm = new FakeLLM((): string | LLMResponse => {
      if (dispatched) return "done";
      dispatched = true;
      return {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "a", name: "conc1", input: {} },
          { type: "tool_use", id: "b", name: "plain", input: {} },
          { type: "tool_use", id: "c", name: "conc2", input: {} },
        ],
      };
    });
    const agent = new Agent(llm, {
      tools: [mk("conc1", true), mk("plain", false), mk("conc2", true)],
      maxConcurrency: 5,
    });
    expect(await agent.send("go")).toBe("done");
    expect(flight.max).toBe(1); // 串行:任意时刻只有 1 个在飞
  });

  test("失败隔离:并发中一个抛错,不带崩其余,结果按 id 各自配对", async () => {
    const flaky: Tool = {
      name: "flaky",
      description: "",
      concurrent: true,
      inputSchema: { type: "object", properties: {} },
      run: async (input) => {
        if (input.i === 1) throw new Error("boom"); // 第 2 个失败
        return `ok:${input.i}`;
      },
    };
    const agent = new Agent(fanOut("flaky", 3), { tools: [flaky] });
    expect(await agent.send("go")).toBe("done"); // 整轮照常收敛

    const results = agent
      .getHistory()
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    const byId = new Map(results.map((r) => [r.type === "tool_result" ? r.tool_use_id : "", r]));
    // 失败的那个是 is_error;其余正常。配对不错位。
    const c1 = byId.get("c1");
    const c0 = byId.get("c0");
    expect(c1 && c1.type === "tool_result" ? c1.is_error : false).toBe(true);
    expect(c0 && c0.type === "tool_result" ? c0.is_error : true).toBeFalsy();
    expect(c0 && c0.type === "tool_result" ? c0.content : "").toBe("ok:0");
  });
});

describe("并行派活:子 agent 存档序号并发不撞", () => {
  test("一轮并发派 3 个子 agent → agent-1/2/3.jsonl 各自独立、无覆盖", async () => {
    const sessionId = "sess-parallel";
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system === SUBAGENT_SYSTEM) return "子结论"; // 每个子 agent 直接给结论
      const dispatched = messages.some(
        (m) =>
          Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
      );
      if (dispatched) return "汇总完成";
      return {
        stopReason: "tool_use",
        content: [1, 2, 3].map((i) => ({
          type: "tool_use" as const,
          id: `d${i}`,
          name: DISPATCH_TOOL_NAME,
          input: { prompt: `子任务${i}` },
        })),
      };
    });

    let dispatchTool: Tool;
    dispatchTool = createDispatchAgentTool({
      llm,
      getTools: () => [dispatchTool],
      getSessionId: () => sessionId,
    });
    const agent = new Agent(llm, { tools: [dispatchTool] });
    expect(await agent.send("并发派三个")).toBe("汇总完成");

    // 三个子 agent 各拿到唯一短 id → 三个独立档案(无覆盖)。
    const dir = join(TMP, sessionId, "agents");
    const files = readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
    expect(files).toHaveLength(3);
    expect(new Set(files).size).toBe(3); // id 不撞,三个不同文件名
    // 确实跑了 3 个子 agent(3 次带 SUBAGENT_SYSTEM 的调用)。
    const subCalls = llm.calls.filter((c) => c.system === SUBAGENT_SYSTEM).length;
    expect(subCalls).toBe(3);
  });
});
