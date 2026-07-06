import { describe, expect, test } from "bun:test";
import { ContextCompactor, type FrozenState } from "../src/compactor";
import type { CompactEvent } from "../src/compactor";
import type { Message } from "../src/types";
import { FakeLLM } from "./fake-llm";

// 直接对着 ContextCompactor.compact 喂历史断言——剥离后压缩单测不再需要立完整 Agent。
// 压缩器无状态:每步把返回的 frozen 状态喂回下一次 compact(模拟 Agent 的 send 循环)。
describe("ContextCompactor 压缩器", () => {
  const EMPTY: FrozenState = { frozenCount: 0, frozenCursors: [] };

  // 造一段够长、能触发压缩的历史：n 轮 user/assistant。
  function longHistory(n: number): Message[] {
    const h: Message[] = [];
    for (let i = 1; i <= n; i++) {
      h.push({ role: "user", content: `这是第${i}句话用来把上下文撑长占位占位占位` });
      h.push({ role: "assistant", content: `第${i}句的回复也要够长占位占位占位占位` });
    }
    return h;
  }

  // 摘要请求(system 含 "摘要")每次返回递增编号,便于验证「已冻结块不被重写」。
  function countingSummarizerLLM(failAfter = Infinity) {
    let n = 0;
    return new FakeLLM((_m, opts) => {
      if (opts.system?.includes("摘要")) {
        n++;
        if (n > failAfter) throw new Error("summarize failed");
        return `摘要#${n}`;
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
  }

  // 数 history 开头连续的冻结块(以 [对话摘要] 开头的 user 字符串消息)。
  function leadingFrozen(h: Message[]): string[] {
    const out: string[] = [];
    for (const m of h) {
      if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[对话摘要]")) {
        out.push(m.content);
      } else break;
    }
    return out;
  }

  function make(llm: FakeLLM, over: Partial<Record<string, number>> = {}) {
    return new ContextCompactor({
      llm,
      onUsage: () => {},
      maxContextTokens: 30, // 很小,强制压缩
      keepRecentTurns: 1,
      mergeBlockThreshold: 100, // 默认关掉合并,隔离增量冻结
      mergeZoneRatio: 100,
      ...over,
    });
  }

  // 跑一遍「逐轮追加 + 压缩」循环,返回最终历史 + 各步事件(模拟 Agent send 循环)。
  async function run(
    c: ContextCompactor,
    turns: number,
  ): Promise<{ history: Message[]; events: (CompactEvent | undefined)[] }> {
    let h: Message[] = [];
    let fr: FrozenState = EMPTY;
    const events: (CompactEvent | undefined)[] = [];
    for (let i = 1; i <= turns; i++) {
      h.push({ role: "user", content: `这是第${i}句话用来把上下文撑长占位占位占位` });
      h.push({ role: "assistant", content: `第${i}句的回复也要够长占位占位占位占位` });
      const r = await c.compact(h, fr);
      h = r.history;
      fr = r.frozen;
      events.push(r.event);
    }
    return { history: h, events };
  }

  test("未过阈值：原样返回,event 为 undefined、引用不变", async () => {
    const c = make(countingSummarizerLLM(), { maxContextTokens: 100000 });
    const h = longHistory(2);
    const r = await c.compact(h, EMPTY);
    expect(r.event).toBeUndefined();
    expect(r.history).toBe(h); // 同引用,写回是幂等空操作
    expect(r.frozen).toBe(EMPTY);
  });

  test("冻结区之后无可摘旧轮：原样返回", async () => {
    // 只有 1 轮 + keepRecentTurns=1 → old 为空。历史撑到超阈值但没有可摘的旧轮。
    const c = make(countingSummarizerLLM());
    const h = longHistory(1);
    const r = await c.compact(h, EMPTY);
    expect(r.event).toBeUndefined();
    expect(leadingFrozen(r.history)).toEqual([]);
  });

  test("增量冻结：一次压缩产出一个新块、游标推进、strategy=freeze", async () => {
    const c = make(countingSummarizerLLM());
    const r = await c.compact(longHistory(4), EMPTY);
    expect(r.event?.strategy).toBe("freeze");
    expect(r.frozen.frozenCount).toBe(1);
    expect(leadingFrozen(r.history)).toEqual(["[对话摘要]\n摘要#1"]);
    expect(r.frozen.frozenCursors.at(-1)!).toBeGreaterThan(0); // 游标已推进
  });

  test("已冻结块跨多次压缩逐字不变（退化链断开、多块并存）", async () => {
    const { history } = await run(make(countingSummarizerLLM()), 6);
    const blocks = leadingFrozen(history);
    expect(blocks.length).toBeGreaterThan(1); // 多块并存,不是单块被反复重摘
    expect(blocks[0]).toBe("[对话摘要]\n摘要#1"); // 第一块从未被改写
    expect(blocks[1]).toBe("[对话摘要]\n摘要#2"); // 按序累积
  });

  test("增量时把已有冻结块作只读上下文喂入,但只输出新块", async () => {
    const llm = countingSummarizerLLM();
    await run(make(llm), 6);
    const summaryCalls = llm.calls.filter((x) => x.system?.includes("摘要"));
    expect(summaryCalls.length).toBeGreaterThan(1);
    // 第二次摘要:prompt 带「已有摘要」只读上下文,且含上一块内容(帮助解引用)。
    const secondPrompt = summaryCalls[1]!.messages[0]!.content as string;
    expect(secondPrompt).toContain("已有摘要");
    expect(secondPrompt).toContain("摘要#1");
  });

  test("到阈值触发合并：全部冻结块塌成一块、strategy=merge", async () => {
    const c = make(countingSummarizerLLM(), { mergeBlockThreshold: 3 }); // 攒够 3 块就合并
    const { events } = await run(c, 8);
    const merge = events.find((e) => e?.strategy === "merge");
    expect(merge).toBeDefined();
    expect(merge!.frozenBlocks).toBe(1); // 合并后单块
  });

  test("摘要失败兜底：截断但冻结块一字不动", async () => {
    // 第 1 次摘要成功(摘要#1),之后都抛错 → 已有冻结块时触发截断兜底。
    const c = make(countingSummarizerLLM(1));
    const { history, events } = await run(c, 6);
    expect(events.some((e) => e?.strategy === "freeze")).toBe(true);
    expect(events.some((e) => e?.strategy === "truncate")).toBe(true);
    expect(leadingFrozen(history)[0]).toBe("[对话摘要]\n摘要#1"); // 冻结块仍在
  });

  test("onUsage：摘要那次调用的用量回流", async () => {
    let total = 0;
    const llm = new FakeLLM((_m, opts) => {
      if (opts.system?.includes("摘要")) {
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: "摘要" }],
          usage: { input: 5, output: 3, cacheRead: 0, cacheCreation: 0 },
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
    const c = new ContextCompactor({
      llm,
      onUsage: (u) => {
        if (u) total += u.input + u.output;
      },
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 100,
      mergeZoneRatio: 100,
    });
    const r = await c.compact(longHistory(4), EMPTY);
    expect(r.event?.strategy).toBe("freeze");
    expect(total).toBe(8); // 一次增量冻结 = 一次摘要调用的用量
  });
});
