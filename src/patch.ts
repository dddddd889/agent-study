import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Tool } from "./types";

// 第 21 步:apply_patch —— 一次性、跨多文件、含增删文件的【原子】编辑(Codex 风格补丁)。
// 见 docs/21、ADR-0006。核心洞察:补丁是【模型生成】的、必然有瑕疵,所以靠【内容定位】(非行号)
// + 【全或无原子】+ 可诊断报错让模型重试,而不是错改一半。edit_file/write_file 仍保留分工。

// ---- 结构化操作 ----
interface Hunk {
  oldBlock: string; // 上下文行 + `-` 行(拼成待匹配的旧块)
  newBlock: string; // 上下文行 + `+` 行(替换成的新块)
}
type Op =
  | { type: "update"; path: string; hunks: Hunk[] }
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string };

// ---- 解析 Codex 补丁 ----
// *** Begin Patch / *** End Patch 包裹;文件段以 *** Update|Add|Delete File: <path> 起头。
// Update 段:若干 hunk,以 @@ 行分隔(@@ 内容仅提示、不参与匹配);行首 ' '=上下文 '+'=增 '-'=删。
// Add 段:行首 '+' 的即新文件内容。Delete 段:无正文。
export function parsePatch(text: string): Op[] {
  const lines = text.split("\n");
  let i = 0;
  const err = (msg: string): never => {
    throw new Error(`补丁格式错误：${msg}`);
  };

  // 允许 Begin/End 前后有空白行。
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.trim() !== "*** Begin Patch") err('缺少 "*** Begin Patch" 起始行');
  i++;

  const ops: Op[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "*** End Patch") {
      i++;
      break;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }

    const mUpd = line.match(/^\*\*\* Update File: (.+)$/);
    const mAdd = line.match(/^\*\*\* Add File: (.+)$/);
    const mDel = line.match(/^\*\*\* Delete File: (.+)$/);

    if (mDel) {
      ops.push({ type: "delete", path: mDel[1]!.trim() });
      i++;
    } else if (mAdd) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith("+")) buf.push(l.slice(1));
        else if (l.trim() === "") buf.push("");
        else err(`Add File 段里出现非 '+' 行：${l}`);
        i++;
      }
      ops.push({ type: "add", path: mAdd[1]!.trim(), content: buf.join("\n") });
    } else if (mUpd) {
      i++;
      const hunks: Hunk[] = [];
      let oldB: string[] = [];
      let newB: string[] = [];
      const flush = () => {
        if (oldB.length || newB.length) {
          hunks.push({ oldBlock: oldB.join("\n"), newBlock: newB.join("\n") });
          oldB = [];
          newB = [];
        }
      };
      while (i < lines.length && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith("@@")) {
          flush(); // @@ 分隔多个 hunk;内容不参与匹配
        } else if (l.startsWith("+")) {
          newB.push(l.slice(1));
        } else if (l.startsWith("-")) {
          oldB.push(l.slice(1));
        } else if (l.startsWith(" ")) {
          oldB.push(l.slice(1));
          newB.push(l.slice(1));
        } else if (l.trim() === "") {
          // 空行当作上下文空行(两侧都加)
          oldB.push("");
          newB.push("");
        } else {
          err(`Update File 段里出现无前缀行：${l}`);
        }
        i++;
      }
      flush();
      if (!hunks.length) err(`Update File: ${mUpd[1]} 没有任何 hunk`);
      ops.push({ type: "update", path: mUpd[1]!.trim(), hunks });
    } else {
      err(`无法识别的行(应为 "*** Update|Add|Delete File:" 或 "*** End Patch")：${line}`);
    }
  }

  if (!ops.length) err("补丁为空");
  return ops;
}

function isSectionStart(line: string): boolean {
  return (
    /^\*\*\* (Update|Add|Delete) File: /.test(line) || line.trim() === "*** End Patch"
  );
}

// 唯一命中计数(用 split 避免正则转义)。
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "一次性应用一个补丁:可【跨多文件】更新/新增/删除,【全或无原子】(任一处失败则整补丁不写)。" +
    "适合跨文件的批量改动;单处小改用 edit_file、单文件新建/重写用 write_file。\n" +
    "⚠️ Update/Delete 的文件必须先 read_file 读过;Add 的文件必须尚不存在。hunk 靠【上下文行】定位" +
    "(不是行号),上下文要足够让旧块在文件中唯一。格式(严格)：\n" +
    "*** Begin Patch\n" +
    "*** Update File: 相对路径\n" +
    "@@\n" +
    " 不变的上下文行(前面一个空格)\n" +
    "-要删除的行(前面一个减号)\n" +
    "+要新增的行(前面一个加号)\n" +
    "*** Add File: 相对路径\n" +
    "+新文件每一行(前面一个加号)\n" +
    "*** Delete File: 相对路径\n" +
    "*** End Patch",
  dangerous: true, // 改文件系统 → 需确认
  // 不标 concurrent:改文件、讲顺序,与 edit/write 一样串行。
  inputSchema: {
    type: "object",
    properties: {
      patch: { type: "string", description: "完整补丁文本(*** Begin Patch … *** End Patch)" },
    },
    required: ["patch"],
  },
  async run(input, ctx) {
    const ops = parsePatch(String(input.patch ?? ""));

    // ---- 阶段一:校验前置 + 在内存里算出每个文件的最终内容(不落盘) ----
    const writes: Array<{ path: string; content: string }> = [];
    const deletes: string[] = [];
    const summary: string[] = [];

    for (const op of ops) {
      const abs = resolve(op.path);
      if (op.type === "add") {
        if (existsSync(abs)) throw new Error(`Add File 目标已存在:${op.path}(不覆盖;改用 Update)`);
        writes.push({ path: abs, content: op.content });
        const lines = op.content === "" ? 0 : op.content.split("\n").length;
        summary.push(`Add ${op.path}(+${lines})`);
      } else if (op.type === "delete") {
        if (!existsSync(abs)) throw new Error(`Delete File 不存在:${op.path}`);
        if (ctx?.readFiles && !ctx.readFiles.has(abs)) {
          throw new Error(`Delete 前必须先 read_file 读过 ${op.path}`);
        }
        deletes.push(abs);
        summary.push(`Delete ${op.path}`);
      } else {
        // update
        if (!existsSync(abs)) throw new Error(`Update File 不存在:${op.path}`);
        if (ctx?.readFiles && !ctx.readFiles.has(abs)) {
          throw new Error(`Update 前必须先 read_file 读过 ${op.path}`);
        }
        let content = await readFile(abs, { encoding: "utf-8", signal: ctx?.signal });
        let added = 0;
        let removed = 0;
        // 多 hunk 在内存副本上按序应用:后一个看到前一个改完的内容(天然免疫行漂移)。
        for (let h = 0; h < op.hunks.length; h++) {
          const { oldBlock, newBlock } = op.hunks[h]!;
          const n = countOccurrences(content, oldBlock);
          if (n === 0) {
            throw new Error(
              `${op.path} 第 ${h + 1} 个 hunk 未命中(0 次)——请给更精确/更长的上下文;补丁未应用`,
            );
          }
          if (n > 1) {
            throw new Error(
              `${op.path} 第 ${h + 1} 个 hunk 命中 ${n} 次、不唯一——请扩大上下文;补丁未应用`,
            );
          }
          content = content.replace(oldBlock, newBlock);
          added += newBlock === "" ? 0 : newBlock.split("\n").length;
          removed += oldBlock === "" ? 0 : oldBlock.split("\n").length;
        }
        writes.push({ path: abs, content });
        summary.push(`Update ${op.path}(+${added} -${removed})`);
      }
    }

    // ---- 阶段二:全部校验通过 → 一起落盘(原子:走到这里才写第一个字节) ----
    for (const w of writes) {
      await mkdir(dirname(w.path), { recursive: true });
      await writeFile(w.path, w.content, { encoding: "utf-8", signal: ctx?.signal });
      ctx?.readFiles?.add(w.path); // 改/建完即知内容
    }
    for (const d of deletes) {
      await unlink(d);
      ctx?.readFiles?.delete(d); // 没了
    }

    return `已应用补丁：${summary.join("；")}`;
  },
};
