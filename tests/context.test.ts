import { describe, expect, test } from "bun:test";
import {
  countTurns,
  estimateTokens,
  splitForCompaction,
  truncateHistory,
} from "../src/context";
import type { Message } from "../src/types";

describe("estimateTokens", () => {
  test("空历史为 0", () => {
    expect(estimateTokens([])).toBe(0);
  });

  test("更长的文本估值更大（单调性）", () => {
    const short: Message[] = [{ role: "user", content: "hi" }];
    const long: Message[] = [{ role: "user", content: "hi".repeat(100) }];
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  test("能估算内容块（tool_use / tool_result）", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "1", name: "calc", input: { expression: "1+1" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: "2" }],
      },
    ];
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });
});

describe("truncateHistory", () => {
  // 含工具轮的样例历史：3 轮，第 2 轮带工具调用。
  function sampleHistory(): Message[] {
    return [
      { role: "user", content: "第一句" }, // 轮 1
      { role: "assistant", content: "回复一" },
      { role: "user", content: "第二句" }, // 轮 2（带工具）
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "calc", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      { role: "assistant", content: "回复二" },
      { role: "user", content: "第三句" }, // 轮 3
      { role: "assistant", content: "回复三" },
    ];
  }

  test("未超阈值时原样返回", () => {
    const h = sampleHistory();
    expect(truncateHistory(h, 100000)).toBe(h);
  });

  test("超阈值时丢最旧的轮，结果落进预算且变短", () => {
    const h = sampleHistory();
    const max = estimateTokens(h.slice(6)); // 只够最近 1 轮
    const out = truncateHistory(h, max);
    expect(estimateTokens(out)).toBeLessThanOrEqual(max);
    expect(out.length).toBeLessThan(h.length);
  });

  test("结果第一条是真实用户输入（无孤儿 tool_result）", () => {
    const h = sampleHistory();
    const out = truncateHistory(h, 1); // 极小，触发最大截断
    expect(out[0]!.role).toBe("user");
    expect(typeof out[0]!.content).toBe("string");
  });

  test("不拆散 tool_use / tool_result（整轮保留或整轮丢弃）", () => {
    const h = sampleHistory();
    const max = estimateTokens(h.slice(2)); // 保留轮 2、轮 3
    const out = truncateHistory(h, max);
    const hasToolResult = out.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    const hasToolUse = out.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
    );
    expect(hasToolResult).toBe(hasToolUse);
  });

  test("最近一轮自身超阈值时仍保留这 1 轮", () => {
    const h = sampleHistory();
    const out = truncateHistory(h, 1);
    expect(countTurns(out)).toBeGreaterThanOrEqual(1);
    expect(out[0]!.content).toBe("第三句"); // 只剩最近一轮
  });
});

describe("splitForCompaction", () => {
  const h: Message[] = [
    { role: "user", content: "Q1" },
    { role: "assistant", content: "A1" },
    { role: "user", content: "Q2" },
    { role: "assistant", content: "A2" },
    { role: "user", content: "Q3" },
    { role: "assistant", content: "A3" },
  ];

  test("保留最近 K 轮逐字，其余作为旧轮", () => {
    const { old, recent } = splitForCompaction(h, 1);
    expect(recent).toEqual([
      { role: "user", content: "Q3" },
      { role: "assistant", content: "A3" },
    ]);
    expect(old).toEqual(h.slice(0, 4)); // 轮1、轮2
  });

  test("轮数 ≤ K 时没有可摘要的旧轮(old 为空)", () => {
    const { old, recent } = splitForCompaction(h, 5);
    expect(old).toEqual([]);
    expect(recent).toBe(h);
  });

  test("切分点对齐真实用户输入：recent 以 user 字符串开头", () => {
    const { recent } = splitForCompaction(h, 2);
    expect(recent[0]!.role).toBe("user");
    expect(typeof recent[0]!.content).toBe("string");
  });

  describe("带冻结偏移 frozenCount", () => {
    // 开头 1 条冻结块 + 3 轮逐字。
    const frozen: Message[] = [{ role: "user", content: "[对话摘要]\nS1" }];
    const hz: Message[] = [...frozen, ...h];

    test("old/recent 都不含冻结区", () => {
      const { old, recent } = splitForCompaction(hz, 1, 1);
      // 冻结块(下标 0)既不在 old 也不在 recent
      expect(old).not.toContainEqual(frozen[0]);
      expect(recent).not.toContainEqual(frozen[0]);
      // 中间段 = 冻结区之后、最近 1 轮之前
      expect(old).toEqual(h.slice(0, 4));
      expect(recent).toEqual(h.slice(4));
    });

    test("冻结区之后轮数 ≤ K 时 old 为空", () => {
      const { old, recent } = splitForCompaction(hz, 3, 1);
      expect(old).toEqual([]);
      expect(recent).toEqual(h); // 冻结区被跳过,rest 即 h
    });

    test("切点仍对齐真实用户输入", () => {
      const { recent } = splitForCompaction(hz, 2, 1);
      expect(recent[0]!.role).toBe("user");
      expect(typeof recent[0]!.content).toBe("string");
    });
  });
});

describe("truncateHistory 带冻结偏移", () => {
  const frozen: Message[] = [
    { role: "user", content: "[对话摘要]\nS1" },
    { role: "user", content: "[对话摘要]\nS2" },
  ];
  const tail: Message[] = [
    { role: "user", content: "第一句" },
    { role: "assistant", content: "回复一" },
    { role: "user", content: "第二句" },
    { role: "assistant", content: "回复二" },
  ];

  test("冻结区永不丢弃：极小预算仍保留全部冻结块", () => {
    const h = [...frozen, ...tail];
    const out = truncateHistory(h, 1, frozen.length);
    // 前两条冻结块原样在最前
    expect(out.slice(0, 2)).toEqual(frozen);
    // 逐字区被截到只剩最近 1 轮
    expect(out.length).toBeLessThan(h.length);
    expect(out[2]!.content).toBe("第二句");
  });

  test("frozenCount=0 时与旧行为一致", () => {
    const h = [...frozen, ...tail];
    expect(truncateHistory(h, 1)).toEqual(truncateHistory(h, 1, 0));
  });
});
