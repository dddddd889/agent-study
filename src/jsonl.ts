import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// append-only JSONL 流水原语（见 CONTEXT.md「流水」）。
// 把散落各处的「一行一条 JSON、只追不改」的读写收成一处：
//   · encodeJsonl / decodeJsonl —— 纯行编解码，无 I/O，可被派生缓存（如 sidecar）复用。
//   · jsonlLog(path)            —— 绑定一个文件路径的 append-only 流水对象。
// 用同步 fs：CLI 单进程、每轮只追加几行，没必要异步。

// 行编码：一行一条 JSON，末尾带换行。空数组 → 空串（不产生孤零零的换行）。
export function encodeJsonl<T>(items: T[]): string {
  if (items.length === 0) return "";
  return items.map((it) => JSON.stringify(it)).join("\n") + "\n";
}

// 行解码：逐行 parse，忽略空行。严格 —— 坏行直接抛。
// 是否把「抛」翻译成「退化 / 跳过」，由调用方决定（见 session.ts 的 readSidecar / listSubagents）。
export function decodeJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

// 绑定一个文件路径的 append-only 流水。只追不改 + 全量读。
export interface JsonlLog<T> {
  // 追加若干行（每条一行）。空数组是 no-op。自动建父目录 —— 「往这个路径追加」的题中应有之义。
  append(items: T[]): void;
  // 全量读回。文件不存在 → []（不抛）；文件在但有坏行 → 抛（严格，容错归调用方）。
  readAll(): T[];
  exists(): boolean;
}

export function jsonlLog<T>(path: string): JsonlLog<T> {
  return {
    append(items) {
      if (items.length === 0) return;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, encodeJsonl(items), "utf-8");
    },
    readAll() {
      if (!existsSync(path)) return [];
      return decodeJsonl<T>(readFileSync(path, "utf-8"));
    },
    exists() {
      return existsSync(path);
    },
  };
}
