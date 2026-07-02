import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Tool } from "./types";

// 第 20 步:结构化检索 grep / glob —— 纯 JS 手写、零依赖、跨运行时,取代脆弱的 shell 搜索。
// 见 docs/20。为什么不 shell-out rg/find:我们做它就是为了摆脱 shell 搜索(命令易错、跨平台
// 不一、要审批);再去 shell 反而没摆脱。为什么 grep 标 dangerous 而 glob 不:grep 返回文件
// 【内容】(命中行可能含密钥),和 read_file 一致走审批,堵住「grep 绕过读审批」;glob 只给路径,安全。

// ---- 上限(防大仓库把内存/上下文冲爆)----
const GLOB_MAX_FILES = 200; // glob 命中文件数上限
const GREP_MAX_HITS = 100; // grep 命中行上限
const GREP_MAX_LINE = 2000; // 单行长度上限(与 read_file 一致)
const WALK_MAX_FILES = 5000; // 遍历文件数硬上限(兜底)

// ---- 跳过判断:硬编码基线 ∪ 简化根 .gitignore ----
// 始终跳(没 .gitignore 也不裸奔)。
const BASELINE_SKIP = new Set([".git", "node_modules", ".DS_Store"]);

// 简化 .gitignore 规则:普通名 / 目录式(dir/) / 后缀(*.log) / 前导锚定(/build)。
// 不支持:否定 !、子目录嵌套 .gitignore、复杂 ** 组合(留 TODO)。
interface IgnoreRule {
  anchored: boolean; // 以 / 开头 → 只匹配根下
  re: RegExp; // 把 glob 段转成的正则(匹配单个路径段或锚定路径)
  raw: string;
}

function parseGitignore(root: string): IgnoreRule[] {
  const f = join(root, ".gitignore");
  if (!existsSync(f)) return [];
  const rules: IgnoreRule[] = [];
  for (let line of readFileSync(f, "utf-8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue; // 空/注释/否定(不支持)跳过
    const anchored = line.startsWith("/");
    let pat = line.replace(/^\//, "").replace(/\/$/, ""); // 去前导/后置斜杠
    if (!pat) continue;
    rules.push({ anchored, re: segmentGlobToRegExp(pat), raw: line });
  }
  return rules;
}

// 把一个 glob 段(可能含 * ?)转成整段匹配的正则。用于 .gitignore 与文件名匹配。
function segmentGlobToRegExp(pat: string): RegExp {
  const re = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // 转义正则元字符(保留 * ?)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

// 某个相对路径(用 / 分隔)是否该跳过。relPath 是相对遍历根的路径。
// noIgnore=true 时只按硬编码基线跳(不读 .gitignore),用于「就要搜被忽略的目录(如 tmp/)」。
function makeSkipper(root: string, noIgnore = false): (relPath: string) => boolean {
  const rules = noIgnore ? [] : parseGitignore(root);
  return (relPath: string): boolean => {
    const segs = relPath.split("/");
    const base = segs[segs.length - 1]!;
    if (BASELINE_SKIP.has(base)) return true; // 基线:任意层的这些名都跳
    for (const r of rules) {
      if (r.anchored) {
        // 锚定:匹配从根开始的第一段(简化:只比首段)
        if (segs[0] !== undefined && r.re.test(segs[0])) return true;
      } else {
        // 非锚定:任意一段匹配即跳(gitignore 语义:名字可出现在任意层)
        if (segs.some((s) => r.re.test(s))) return true;
      }
    }
    return false;
  };
}

// ---- 递归遍历(带剪枝 + 文件数封顶)----
async function walkFiles(
  root: string,
  onFile: (relPath: string, absPath: string) => Promise<void> | void,
  signal?: AbortSignal,
  noIgnore = false,
): Promise<{ truncated: boolean }> {
  const skip = makeSkipper(root, noIgnore);
  let count = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不了的目录(权限等)跳过
    }
    entries.sort((a, b) => a.name.localeCompare(b.name)); // 稳定顺序
    for (const e of entries) {
      if (truncated) return;
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split("\\").join("/"); // 归一成 /
      if (skip(rel)) continue;
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        if (count >= WALK_MAX_FILES) {
          truncated = true;
          return;
        }
        count++;
        await onFile(rel, abs);
      }
    }
  }

  await walk(root);
  return { truncated };
}

// ---- glob:整路径通配(支持 * 段内 / ** 任意层 / ?)----
function globToRegExp(pattern: string): RegExp {
  // 先转义元字符,再把占位还原成通配。用 \x00/\x01 占位避免 ** 与 * 互相干扰。
  let p = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/\*\*\//g, "\x00"); // **/ → 任意层(含零层)
  p = p.replace(/\*\*/g, "\x01"); // ** → 任意字符(跨目录)
  p = p.replace(/\*/g, "[^/]*"); // * → 段内任意
  p = p.replace(/\?/g, "[^/]"); // ? → 段内单字符
  p = p.replace(/\x00/g, "(?:.*/)?"); // **/ 落地
  p = p.replace(/\x01/g, ".*"); // ** 落地
  return new RegExp(`^${p}$`);
}

export const globTool: Tool = {
  name: "glob",
  description:
    "按文件名模式查找文件,返回匹配的相对路径列表(不返回内容)。" +
    "支持 * (段内)、** (任意层)、? 。例:src/**/*.ts、**/*.test.ts。只读、快速。" +
    "默认跳过 .git/node_modules 及 .gitignore 命中的目录;要搜被忽略的目录(如 tmp/、.sessions/)传 no_ignore: true。",
  dangerous: false, // 只返回路径,安全 → 免审批
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式,如 src/**/*.ts" },
      path: { type: "string", description: "基准目录,默认当前工作目录" },
      no_ignore: {
        type: "boolean",
        description: "为 true 则连 .gitignore 忽略的目录也搜(仍跳 .git/node_modules)。默认 false。",
      },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new Error("glob 需要 pattern");
    const root = resolve(String(input.path ?? "."));
    const noIgnore = input.no_ignore === true;
    const re = globToRegExp(pattern);
    const hits: string[] = [];
    let capped = false;
    const { truncated } = await walkFiles(
      root,
      (rel) => {
        if (hits.length >= GLOB_MAX_FILES) {
          capped = true;
          return;
        }
        if (re.test(rel)) hits.push(rel);
      },
      ctx?.signal,
      noIgnore,
    );
    if (!hits.length) {
      const hint = noIgnore ? "" : "；注意默认跳过 .gitignore 目录(如 tmp/),要搜它们传 no_ignore: true";
      return `（无匹配 ${pattern}${hint}）`;
    }
    const note =
      capped || truncated
        ? `\n…（已达上限 ${GLOB_MAX_FILES}/扫描封顶,请收窄 pattern）`
        : "";
    return hits.join("\n") + note;
  },
};

// ---- grep:逐行正则搜内容 ----
function isBinary(buf: string): boolean {
  return buf.includes("\x00"); // 含 null 字节 → 当二进制,跳过
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "按正则在文件内容里搜索,返回「相对路径:行号:该行」。可用 glob 限定文件范围。" +
    "只读检索(比裸 shell grep 更稳:结构化输出、跨平台、跳 .git/node_modules 及 .gitignore)。" +
    "要搜被 .gitignore 忽略的目录(如 tmp/)传 no_ignore: true。",
  dangerous: true, // 返回文件内容(可能含密钥),与 read_file 一致走审批,堵读绕过
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式(JS 语法)" },
      path: { type: "string", description: "搜索目录(递归)或单文件,默认当前工作目录" },
      glob: { type: "string", description: "可选:只搜匹配此 glob 的文件,如 *.ts" },
      ignore_case: { type: "boolean", description: "忽略大小写,默认 false" },
      no_ignore: {
        type: "boolean",
        description: "为 true 则连 .gitignore 忽略的目录也搜(仍跳 .git/node_modules)。默认 false。",
      },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const patternStr = String(input.pattern ?? "");
    if (!patternStr) throw new Error("grep 需要 pattern");
    let re: RegExp;
    try {
      re = new RegExp(patternStr, input.ignore_case === true ? "i" : "");
    } catch (e) {
      throw new Error(`非法正则: ${(e as Error).message}`);
    }
    const target = resolve(String(input.path ?? "."));
    const noIgnore = input.no_ignore === true;
    const fileFilter = input.glob ? globToRegExp(String(input.glob)) : null;
    const hits: string[] = [];
    let capped = false;

    // 单文件 vs 目录。
    const st = existsSync(target) ? await stat(target) : null;
    if (!st) throw new Error(`路径不存在: ${input.path}`);

    const searchOne = async (rel: string, abs: string) => {
      if (capped) return;
      if (fileFilter && !fileFilter.test(rel.split("/").pop()!) && !fileFilter.test(rel)) return;
      let content: string;
      try {
        content = await readFile(abs, { encoding: "utf-8", signal: ctx?.signal });
      } catch {
        return;
      }
      if (isBinary(content)) return; // 跳二进制
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= GREP_MAX_HITS) {
          capped = true;
          return;
        }
        if (re.test(lines[i]!)) {
          const text =
            lines[i]!.length > GREP_MAX_LINE ? lines[i]!.slice(0, GREP_MAX_LINE) + "…" : lines[i]!;
          hits.push(`${rel}:${i + 1}:${text}`);
        }
      }
    };

    if (st.isFile()) {
      await searchOne(relative(process.cwd(), target).split("\\").join("/") || target, target);
    } else {
      await walkFiles(target, searchOne, ctx?.signal, noIgnore);
    }

    if (!hits.length) {
      const hint = noIgnore ? "" : "；注意默认跳过 .gitignore 目录(如 tmp/),要搜它们传 no_ignore: true";
      return `（无命中 /${patternStr}/${hint}）`;
    }
    const note = capped ? `\n…（已达命中上限 ${GREP_MAX_HITS},请收窄 pattern 或 path）` : "";
    return hits.join("\n") + note;
  },
};
