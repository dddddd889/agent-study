import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessages,
  listSessions,
  loadSession,
  newSessionId,
} from "../src/session";
import type { Message } from "../src/types";

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
