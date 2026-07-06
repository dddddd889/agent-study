import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessages,
  listSessions,
  loadSession,
  newSessionId,
  restoreFrozen,
  writeSummary,
} from "../src/session";
import type { Message } from "../src/types";

const u = (s: string): Message => ({ role: "user", content: s });
const a = (s: string): Message => ({ role: "assistant", content: s });
// 造一条长 n 的主流水：偶数位是真实用户输入(字符串 content),奇数位是 assistant。
// 于是任意偶数下标都落在「轮边界」上,便于给游标对齐。
const mkPrior = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => (i % 2 === 0 ? u(`u${i}`) : a(`a${i}`)));

// 用临时目录隔离，避免误删用户真实的 .sessions/。
const DIR = mkdtempSync(join(tmpdir(), "agent-sessions-"));
process.env.AGENT_SESSIONS_DIR = DIR;
function cleanup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => {
  cleanup();
  process.env.AGENT_SESSIONS_DIR = DIR; // mkdir 会重建
});
afterAll(cleanup);

describe("session 持久化", () => {
  test("newSessionId 每次不同", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  test("append 后能原样 load 回来（含内容块）", () => {
    const id = newSessionId();
    const turn1: Message[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好呀" },
    ];
    const turn2: Message[] = [
      { role: "user", content: "算一下" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "calc", input: { x: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: "1" }],
      },
    ];

    appendMessages(id, turn1);
    appendMessages(id, turn2); // 第二轮追加，不重写

    expect(loadSession(id)).toEqual([...turn1, ...turn2]);
  });

  test("load 不存在的会话返回空", () => {
    expect(loadSession(newSessionId())).toEqual([]);
  });

  test("listSessions 返回 id + 首条用户消息摘要", () => {
    const id = newSessionId();
    appendMessages(id, [
      { role: "user", content: "第一句问题" },
      { role: "assistant", content: "回答" },
    ]);

    const list = listSessions();
    const found = list.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found!.preview).toBe("第一句问题");
  });
});

describe("冻结区重建 restoreFrozen", () => {
  test("命中(frozen)：write → restoreFrozen 往返冻结块 + 游标之后逐字", () => {
    const id = newSessionId();
    writeSummary(id, ["[对话摘要]\nS1", "[对话摘要]\nS2"], [4, 8]);
    const prior = mkPrior(10); // 游标 8 落在下标 8(真实用户输入),之后还有两条
    const plan = restoreFrozen(prior, id);
    expect(plan.reason).toBe("frozen");
    expect(plan.blocks).toEqual(["[对话摘要]\nS1", "[对话摘要]\nS2"]);
    expect(plan.cursors).toEqual([4, 8]);
    expect(plan.rest).toEqual(prior.slice(8));
  });

  test("命中：游标 === 主流水长度 → 全冻结,rest 为空", () => {
    const id = newSessionId();
    writeSummary(id, ["[对话摘要]\nS1"], [4]);
    const plan = restoreFrozen(mkPrior(4), id);
    expect(plan.reason).toBe("frozen");
    expect(plan.rest).toEqual([]);
  });

  test("缺失(missing)：无 sidecar → 空冻结块 + rest = 整条主流水", () => {
    const prior = mkPrior(3);
    const plan = restoreFrozen(prior, newSessionId());
    expect(plan.reason).toBe("missing");
    expect(plan.blocks).toEqual([]);
    expect(plan.rest).toBe(prior); // 原样透传
  });

  test("损坏(corrupt)：文件读不动 → 退回全量", () => {
    const id = newSessionId();
    writeSummary(id, ["[对话摘要]\nS1"], [4]); // 先建目录 + 文件
    writeFileSync(join(DIR, id, "summary.jsonl"), "这不是 json\n", "utf-8");
    const plan = restoreFrozen(mkPrior(4), id);
    expect(plan.reason).toBe("corrupt");
    expect(plan.blocks).toEqual([]);
  });

  test("损坏(corrupt)：游标非严格递增 → 结构不自洽", () => {
    const id = newSessionId();
    writeSummary(id, ["[对话摘要]\nS1"], [4]); // 建目录
    writeFileSync(
      join(DIR, id, "summary.jsonl"),
      JSON.stringify({ seq: 1, cursorAfter: 8, text: "[对话摘要]\nA" }) +
        "\n" +
        JSON.stringify({ seq: 2, cursorAfter: 4, text: "[对话摘要]\nB" }) +
        "\n",
      "utf-8",
    );
    expect(restoreFrozen(mkPrior(10), id).reason).toBe("corrupt");
  });

  test("越界(invalid)：游标 > 主流水长度 → 退回全量", () => {
    const id = newSessionId();
    writeSummary(id, ["[对话摘要]\nS1"], [99]);
    const plan = restoreFrozen(mkPrior(4), id);
    expect(plan.reason).toBe("invalid");
    expect(plan.blocks).toEqual([]);
  });

  test("错位(invalid)：游标没落在真实用户输入边界 → 退回全量", () => {
    const id = newSessionId();
    writeSummary(id, ["[对话摘要]\nS1"], [1]); // 下标 1 是 assistant,非轮边界
    expect(restoreFrozen(mkPrior(4), id).reason).toBe("invalid");
  });

  test("合并式重写：块数变少、游标不变(经 restoreFrozen 观测)", () => {
    const id = newSessionId();
    const prior = mkPrior(12); // 游标 12 === 长度,恒命中
    writeSummary(id, ["[对话摘要]\nS1", "[对话摘要]\nS2", "[对话摘要]\nS3"], [4, 8, 12]);
    expect(restoreFrozen(prior, id).blocks).toHaveLength(3);
    writeSummary(id, ["[对话摘要]\n合并块"], [12]); // 塌成一块,cursorAfter 仍 12
    const plan = restoreFrozen(prior, id);
    expect(plan.reason).toBe("frozen");
    expect(plan.blocks).toHaveLength(1);
    expect(plan.cursors[plan.cursors.length - 1]).toBe(12);
  });

  test("空冻结区 → 删除 sidecar → 之后重建为 missing", () => {
    const id = newSessionId();
    const prior = mkPrior(4);
    writeSummary(id, ["[对话摘要]\nS1"], [4]);
    expect(restoreFrozen(prior, id).reason).toBe("frozen");
    writeSummary(id, [], []); // 空冻结区删文件
    expect(restoreFrozen(prior, id).reason).toBe("missing");
  });
});
