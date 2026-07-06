import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isUserInput } from "./context";
import { decodeJsonl, encodeJsonl, jsonlLog } from "./jsonl";
import type { Message, RestorePlan, RestoreReason } from "./types";

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
  jsonlLog<Message>(sessionPath(id)).append(messages);
}

// 读取整个会话的历史。文件不存在返回空；坏行会抛（续聊是唯一真相，宁炸不吞）。
export function loadSession(id: string): Message[] {
  return jsonlLog<Message>(sessionPath(id)).readAll();
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

// 附件 blob 仓(第29步 / docs/adr/0013):旁挂 <sessionsDir>/<id>/blobs/,与 summary.jsonl、
// agents/ 同级。内容寻址,一文件一 blob(文件名=sha256)。归会话所有——手动删会话目录时随之一并没
// (本内核无程序化删会话);不单独 GC。供 CLI 拼给 attachments.ingest / resolveBlob;
// session 本身不读写 blob(那是 attachments 的事)。
export function blobDir(id: string): string {
  return join(sessionsDir(), id, "blobs");
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
  const rows: FrozenBlockLine[] = blocks.map((text, i) => ({
    seq: i + 1,
    cursorAfter: cursors[i] ?? 0,
    text,
  }));
  // 派生缓存：整文件重写（非 append），故不走 jsonlLog，只复用行编码。
  writeFileSync(path, encodeJsonl(rows), "utf-8");
}

// 读盘 + parse 一层(私有)：区分「无文件(missing)」与「读不动/空(corrupt)」。
// 结构校验与游标校验留给 restoreFrozen —— 读盘只管把行拿回来、认出坏文件。
function readSidecar(
  id: string,
):
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "ok"; blocks: string[]; cursors: number[] } {
  const path = summaryPath(id);
  if (!existsSync(path)) return { status: "missing" };
  let rows: FrozenBlockLine[];
  try {
    rows = decodeJsonl<FrozenBlockLine>(readFileSync(path, "utf-8"));
  } catch {
    return { status: "corrupt" }; // 坏行 → 坏文件（把 decodeJsonl 的抛翻译成 corrupt）
  }
  // 空冻结区时 writeSummary 会删文件；文件在却空 = 被写坏了。
  if (rows.length === 0) return { status: "corrupt" };
  return {
    status: "ok",
    blocks: rows.map((r) => r.text),
    cursors: rows.map((r) => r.cursorAfter),
  };
}

// 冻结区重建(见 CONTEXT.md「冻结区重建」、docs/adr/0012)：sidecar 的读取侧深模块。
// 收注入的主流水 prior(Agent 保持 I/O-free,持久化读取归本层),吐一个统一退化的【重建方案】：
//   · 命中(frozen)：sidecar 有效且游标对得上 prior → {blocks, cursors, prior.slice(cursor)}
//   · 回退(missing/corrupt/invalid)：一律 {[], [], prior} —— 空冻结块即等价全量恢复
// 于是调用方无需分支,拿到方案直接 loadHistoryWithFrozen(plan) 即可(命中/回退都成立)。
// 校验分两层,与 reason 一一对应：
//   结构不自洽(块数≠游标数/非单调/非法数) → corrupt(文件坏)；
//   游标对不上主流水(越界或没落在轮边界) → invalid(多半是冻结逻辑 bug)。
export function restoreFrozen(prior: Message[], id: string): RestorePlan {
  const full = (reason: RestoreReason): RestorePlan => ({
    blocks: [],
    cursors: [],
    rest: prior,
    reason,
  });

  const sc = readSidecar(id);
  if (sc.status !== "ok") return full(sc.status); // missing / corrupt

  const { blocks, cursors } = sc;
  // 结构校验 → corrupt：块数=游标数>0、游标为非负整数且严格递增。
  const structOk =
    blocks.length > 0 &&
    blocks.length === cursors.length &&
    cursors.every(
      (c, i) => Number.isInteger(c) && c >= 0 && (i === 0 || c > cursors[i - 1]!),
    );
  if (!structOk) return full("corrupt");

  // 游标校验 → invalid：末游标在界内,且正好落在主流水的「真实用户输入」边界(或末尾)。
  const cursor = cursors[cursors.length - 1]!;
  const cursorOk =
    cursor <= prior.length &&
    (cursor === prior.length || isUserInput(prior[cursor]!));
  if (!cursorOk) return full("invalid");

  return { blocks, cursors, rest: prior.slice(cursor), reason: "frozen" };
}

// 追加子 agent 本轮消息(每条一行,append-only),自动建目录。
export function appendSubagentMessages(
  mainId: string,
  id: string,
  messages: Message[],
): void {
  const path = join(subagentDir(mainId), `agent-${id}.jsonl`);
  jsonlLog<Message>(path).append(messages);
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
        msgs = jsonlLog<Message>(join(dir, f)).readAll();
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
