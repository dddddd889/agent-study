import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "./types";

// 会话持久化：每个会话一个 JSONL 文件（每行一条 Message），append-only。
// 磁盘保留「完整流水」，内存里的历史可被 compactHistory 截断 —— 两者有意分离。
// 用同步 fs 即可：CLI 单进程、每轮就追加几行，没必要异步。

// 存储目录默认 .sessions/；可用 AGENT_SESSIONS_DIR 覆盖（测试用临时目录，避免误删真实会话）。
// 用函数惰性读取，以便测试在 import 之后再设置环境变量。
function sessionsDir(): string {
  return process.env.AGENT_SESSIONS_DIR ?? ".sessions";
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.jsonl`);
}

export function newSessionId(): string {
  return randomUUID();
}

// 追加本轮新增的消息（每条一行）。append-only，绝不重写已有内容。
export function appendMessages(id: string, messages: Message[]): void {
  if (messages.length === 0) return;
  mkdirSync(sessionsDir(), { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  appendFileSync(sessionPath(id), lines, "utf-8");
}

// 读取整个会话的历史（逐行 parse）。
export function loadSession(id: string): Message[] {
  const path = sessionPath(id);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Message);
}

// 列出已有会话：id、更新时间（文件 mtime）、首条用户消息摘要。按最近更新排序。
export function listSessions(): Array<{
  id: string;
  updatedAt: Date;
  preview: string;
}> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const id = f.replace(/\.jsonl$/, "");
      const updatedAt = statSync(join(dir, f)).mtime;
      let preview = "";
      try {
        const first = loadSession(id).find(
          (m) => m.role === "user" && typeof m.content === "string",
        );
        if (first && typeof first.content === "string") preview = first.content;
      } catch {
        // 损坏的文件跳过摘要
      }
      return { id, updatedAt, preview };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
