import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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
// 只认 *.jsonl 文件,所以 <主id>/(子 agent 存档目录)会被自动忽略,不污染会话列表。
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

// ===== 子 agent 存档（第 15/16 步）=====
// 子 agent 的完整历史存到主会话目录下的 agents/ 子目录,与主会话流水【分开】:
//   .sessions/<主id>/agents/agent-<id>.jsonl   (<id> = 子 agent 的随机短 id)
// 主上下文与主会话流水都不含它,只留一条「结论」;这里的存档仅供事后观测(/agents)。
// 用随机短 id(而非顺序号):并行时天然唯一、不撞,且显示上便于配色/区分(见 docs/16)。

function subagentDir(mainId: string): string {
  return join(sessionsDir(), mainId, "agents");
}

// ── 记忆游标 sidecar(第04步 / docs/28) ──────────────────────────────
// 旁挂 <sessionsDir>/<id>/summary.jsonl 的【派生缓存】：一行一个冻结块 + cursorAfter。
// 主流水 <id>.jsonl 才是唯一真相 —— sidecar 可自由重写(合并时)、可整体丢弃(校验不过就重摘),
// 丢了自愈、绝不因它丢历史。只主 agent 落盘(子 agent 不续聊)。
function summaryPath(id: string): string {
  return join(sessionsDir(), id, "summary.jsonl");
}

interface FrozenBlockLine {
  seq: number; // 1 起的块序号
  cursorAfter: number; // 折进本块(含)后的原始消息累计数
  text: string; // 冻结块完整内容(含 [对话摘要] 前缀)
}

// 重写整个 sidecar（派生缓存,允许重写；合并会让行数变少）。空冻结区则删除文件。
export function writeSummary(
  id: string,
  blocks: string[],
  cursors: number[],
): void {
  const path = summaryPath(id);
  if (blocks.length === 0) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  mkdirSync(join(sessionsDir(), id), { recursive: true });
  const lines =
    blocks
      .map((text, i) =>
        JSON.stringify({
          seq: i + 1,
          cursorAfter: cursors[i] ?? 0,
          text,
        } satisfies FrozenBlockLine),
      )
      .join("\n") + "\n";
  writeFileSync(path, lines, "utf-8");
}

// 读回 sidecar：{blocks, cursors, cursor}。文件缺失/损坏 → null(调用方退回全量重摘)。
export function readSummary(
  id: string,
): { blocks: string[]; cursors: number[]; cursor: number } | null {
  const path = summaryPath(id);
  if (!existsSync(path)) return null;
  try {
    const rows = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as FrozenBlockLine);
    if (rows.length === 0) return null;
    const blocks = rows.map((r) => r.text);
    const cursors = rows.map((r) => r.cursorAfter);
    return { blocks, cursors, cursor: cursors[cursors.length - 1] ?? 0 };
  } catch {
    return null; // 损坏 → 丢缓存,自愈
  }
}

// 追加子 agent 本轮消息(每条一行,append-only),自动建目录。
export function appendSubagentMessages(
  mainId: string,
  id: string,
  messages: Message[],
): void {
  if (messages.length === 0) return;
  mkdirSync(subagentDir(mainId), { recursive: true });
  const path = join(subagentDir(mainId), `agent-${id}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  appendFileSync(path, lines, "utf-8");
}

// 列出某主会话派出过的子 agent(给 /agents 观测):短 id、消息数、首条 prompt 摘要。
// 无顺序号了,按文件 mtime(最近在后)排序。
export function listSubagents(mainId: string): Array<{
  id: string;
  messages: number;
  preview: string;
}> {
  const dir = subagentDir(mainId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^agent-.+\.jsonl$/.test(f))
    .map((f) => {
      const id = f.match(/^agent-(.+)\.jsonl$/)![1]!;
      const mtime = statSync(join(dir, f)).mtimeMs;
      let msgs: Message[] = [];
      try {
        msgs = readFileSync(join(dir, f), "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Message);
      } catch {
        // 损坏的档案跳过内容,仍列出 id
      }
      const first = msgs.find(
        (m) => m.role === "user" && typeof m.content === "string",
      );
      const preview =
        first && typeof first.content === "string" ? first.content : "";
      return { id, messages: msgs.length, preview, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ id, messages, preview }) => ({ id, messages, preview }));
}
