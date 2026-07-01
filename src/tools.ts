import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { todoWriteTool } from "./todo";
import type { Tool } from "./types";

const execAsync = promisify(exec);

// 工具结果若太长会瞬间吃光上下文 token，统一截断。
const MAX_OUTPUT = 10000;
function truncate(text: string): string {
  return text.length > MAX_OUTPUT
    ? text.slice(0, MAX_OUTPUT) + "\n…（已截断）"
    : text;
}

// 剥掉所有 HTML 标签。
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

// 解码常见 HTML 实体（在剥完标签后做，避免把 &lt; 误当成标签）。
function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => map[m] ?? m);
}

// 把 HTML 粗略转成 Markdown：删噪音 → 结构转 md → 剥标签 → 解码实体 → 压空白。
// 极简实现，靠正则，对复杂/畸形页面会有瑕疵；目的是“砍掉网页噪音、省 token”。
// TODO: 用 readability 提取正文（去导航/页脚/广告）；用 turndown 或 Bun HTMLRewriter
//       做健壮解析；表格 / 图片等精细处理。
export function htmlToMarkdown(html: string): string {
  let s = html;
  // 1. 删干净：注释、script、style、head —— 纯噪音。
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // 2. 结构转 markdown。
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, lv, inner) => `\n${"#".repeat(Number(lv))} ${stripTags(inner).trim()}\n`,
  );
  s = s.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => {
      const text = stripTags(inner).trim();
      return text ? `[${text}](${href})` : "";
    },
  );
  s = s.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _t, inner) => `**${stripTags(inner).trim()}**`,
  );
  s = s.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_m, inner) => `\n\`\`\`\n${stripTags(inner).trim()}\n\`\`\`\n`,
  );
  s = s.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_m, inner) => `\`${stripTags(inner).trim()}\``,
  );
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${stripTags(inner).trim()}`);
  s = s.replace(/<\/(p|div)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // 3. 剥掉其余所有标签。
  s = stripTags(s);
  // 4. 解码常见实体。
  s = decodeEntities(s);
  // 5. 压空白：行尾空白去掉，连续 3+ 空行压成 2。
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// TODO: 工具变多后，把本文件按类别拆成 src/tools/ 目录（builtin / fs / http / shell）。

// ============ 纯工具（无副作用）============

// 工具 1：返回当前日期时间。
// 模型本身不知道“现在几点”，这类实时信息正适合用工具补足。
export const getCurrentTime: Tool = {
  name: "get_current_time",
  description:
    "获取当前的日期和时间（ISO 8601 字符串）。当用户问“现在几点 / 今天几号”等实时信息时使用。",
  inputSchema: { type: "object", properties: {} },
  run() {
    return new Date().toISOString();
  },
};

// 工具 2：四则运算计算器。
// 模型做大数或多步算术容易出错，交给确定性的代码更可靠。
export const calculator: Tool = {
  name: "calculator",
  description: '计算一个数学表达式，例如 "(3 + 4) * 5"。需要做算术时使用。',
  inputSchema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "要计算的数学表达式，只含数字和 + - * / ( ) 运算符",
      },
    },
    required: ["expression"],
  },
  run(input) {
    const expr = String(input.expression ?? "");
    // 安全起见：只允许数字、运算符、小数点、括号和空格，杜绝任意代码执行。
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      throw new Error(`表达式包含非法字符: ${expr}`);
    }
    // 在受限字符集前提下求值；仅用于学习演示。
    const value = Function(`"use strict"; return (${expr});`)();
    return String(value);
  },
};

// ============ 副作用工具（碰文件系统 / 网络 / 进程）============
// 学习项目刻意只做最简实现，把“护栏”留成 TODO，方便看清核心。

// 分页 read 的默认值(第19步)。
const READ_DEFAULT_LIMIT = 2000; // 默认读多少行
const READ_MAX_LINE = 2000; // 单行最长多少字符(超长省略,防压缩行炸上下文)

// 工具 3：读取文件内容（分页 + 带行号）。
// 行号是为了让模型定位、报 file:line、决定下一段读哪;⚠️ Edit 的 old_string 用【真实内容】,
// 不含这里显示的「行号 + Tab」前缀。见 docs/19。
export const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取文本文件并返回带行号的内容（UTF-8）。大文件用 offset/limit 分页读。" +
    `默认从头读 ${READ_DEFAULT_LIMIT} 行,单行超 ${READ_MAX_LINE} 字符会省略。\n` +
    "⚠️ 输出每行前缀是「行号+Tab」,仅供定位;用 Edit 时 old_string 要用文件【真实内容】,不含该前缀。",
  dangerous: true, // 能读到密钥/隐私文件，且可能被外发 → 需确认
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对路径相对于进程工作目录）" },
      offset: { type: "number", description: `起始行号(从 1 起,默认 1)` },
      limit: { type: "number", description: `读取行数(默认 ${READ_DEFAULT_LIMIT})` },
    },
    required: ["path"],
  },
  // TODO: 路径沙箱 —— 限制在工作目录内，防止路径穿越 / 越权读取（如 ../../etc/passwd）。
  async run(input, ctx) {
    const path = String(input.path ?? "");
    const raw = await readFile(path, { encoding: "utf-8", signal: ctx?.signal });
    // 读成功即记入本 agent 的「已读集合」,满足 Edit 的 read-before-edit。
    ctx?.readFiles?.add(resolve(path));

    const lines = raw.split("\n");
    const total = lines.length;
    const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
    const limit = Math.max(1, Math.floor(Number(input.limit) || READ_DEFAULT_LIMIT));
    const start = offset - 1;
    const slice = lines.slice(start, start + limit);
    // 行号右对齐 + Tab + 内容(单行超长省略)。
    const width = String(start + slice.length).length;
    const body = slice
      .map((line, i) => {
        const no = String(start + i + 1).padStart(width);
        const text = line.length > READ_MAX_LINE ? line.slice(0, READ_MAX_LINE) + "…（本行已截断）" : line;
        return `${no}\t${text}`;
      })
      .join("\n");
    const shownEnd = start + slice.length;
    const more =
      shownEnd < total
        ? `\n…（共 ${total} 行,已显示 ${offset}-${shownEnd};继续用 offset=${shownEnd + 1}）`
        : "";
    return `${body}${more}`;
  },
};

// 工具 4：写入文件（覆盖写，自动创建父目录）—— 管【新建 / 整文件重写】;改一处用 Edit。
export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "把文本写入文件（覆盖已有内容，自动创建缺失的父目录）。用于新建文件或整文件重写;" +
    "只改其中一处请用 edit_file。",
  dangerous: true, // 改文件系统 → 需确认
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对路径相对于进程工作目录）" },
      content: { type: "string", description: "要写入的文本内容" },
    },
    required: ["path", "content"],
  },
  // TODO: 路径沙箱 —— 限制在工作目录内，防止路径穿越 / 越权写入。
  async run(input, ctx) {
    const path = String(input.path ?? "");
    const content = String(input.content ?? "");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf-8", signal: ctx?.signal });
    // 写了即知内容,记入已读集合,之后可直接 Edit。
    ctx?.readFiles?.add(resolve(path));
    return `已写入 ${content.length} 个字符到 ${path}`;
  },
};

// 工具 5：精确编辑（字符串替换）—— 改文件某一处。见 docs/19、ADR-0005。
export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "精确编辑文件:把 old_string 替换成 new_string。old_string 必须【唯一命中】(含缩进/空白," +
    "用文件真实内容、不含 read 的行号前缀);命中 0 次或多次会报错——请扩上下文,或用 replace_all 批量替。" +
    "new_string 留空即删除那段。⚠️ 必须先 read_file 读过该文件再编辑。改一处用它;新建/整体重写用 write_file。",
  dangerous: true, // 改文件系统 → 需确认
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: { type: "string", description: "要被替换的原文(唯一命中;含缩进空白,不含行号前缀)" },
      new_string: { type: "string", description: "替换成的新文本(留空=删除)" },
      replace_all: { type: "boolean", description: "命中多处时是否全部替换,默认 false" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(input, ctx) {
    const path = String(input.path ?? "");
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    const replaceAll = input.replace_all === true;

    // read-before-edit:没读过该文件不许改(防盲改/陈旧)。ctx.readFiles 为空则跳过(库外直接调用)。
    if (ctx?.readFiles && !ctx.readFiles.has(resolve(path))) {
      throw new Error(`必须先 read_file 读过 ${path} 再 edit_file（防止盲改/改到陈旧内容）`);
    }
    if (oldStr === "") throw new Error("old_string 不能为空");

    const raw = await readFile(path, { encoding: "utf-8", signal: ctx?.signal });
    // 统计命中次数(用 split 计数,避免正则转义)。
    const count = raw.split(oldStr).length - 1;
    if (count === 0) {
      throw new Error(`未找到 old_string（在 ${path} 中 0 次命中）——请给更精确/更长的上下文`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_string 命中 ${count} 次、不唯一——请扩大上下文使其唯一,或传 replace_all: true 批量替换`,
      );
    }
    const next = replaceAll ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr);
    await writeFile(path, next, { encoding: "utf-8", signal: ctx?.signal });

    // 回显:替换处数 + 改动处前后小片段(取 new_string 落点周围几行),便于确认改对地方。
    const idx = next.indexOf(newStr);
    const around = idx >= 0 ? snippet(next, idx, newStr.length) : "";
    const n = replaceAll ? count : 1;
    return `已在 ${path} 替换 ${n} 处${around ? `：\n${around}` : ""}`;
  },
};

// 取 next 中 [idx, idx+len) 附近的几行,给 Edit 回显用。
function snippet(text: string, idx: number, len: number): string {
  const before = text.lastIndexOf("\n", idx) + 1;
  const afterNl = text.indexOf("\n", idx + len);
  const end = afterNl === -1 ? text.length : afterNl;
  // 往前后各扩一行,给点上下文。
  const ctxStart = text.lastIndexOf("\n", before - 2) + 1;
  const ctxEnd = (() => {
    const nl = text.indexOf("\n", end + 1);
    return nl === -1 ? text.length : nl;
  })();
  return truncate(text.slice(ctxStart, ctxEnd));
}

// 工具 5：发起 HTTP 请求。
export const httpRequestTool: Tool = {
  name: "http_request",
  description:
    "发起一个 HTTP(S) 请求，返回状态码和响应体。需要获取网络数据 / 调接口时使用。",
  dangerous: true, // 有网络副作用（外发数据 / 打内网）→ 需确认
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "请求 URL（仅支持 http/https）" },
      method: { type: "string", description: "HTTP 方法，默认 GET" },
      headers: { type: "object", description: "可选的请求头键值对" },
      body: { type: "string", description: "可选的请求体（字符串）" },
    },
    required: ["url"],
  },
  // TODO: 超时（AbortSignal.timeout）、重定向策略、SSRF 防护（如禁止访问内网地址）。
  async run(input, ctx) {
    const url = String(input.url ?? "");
    // 仅允许 http(s)，挡掉 file:// 等本地协议。
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`只允许 http/https URL: ${url}`);
    }
    // 传入 signal：用户 Ctrl+C 时立即断开请求。
    const res = await fetch(url, {
      method: input.method ? String(input.method) : "GET",
      headers: input.headers as Record<string, string> | undefined,
      body: input.body != null ? String(input.body) : undefined,
      signal: ctx?.signal,
    });
    const raw = await res.text();

    // 是 HTML 就转成 Markdown 再返回（更干净、更省 token）；其它类型原样返回。
    // 先转后截：10k 额度装的是“干货 markdown”而非“半截 HTML”。
    const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
    const body = isHtml ? htmlToMarkdown(raw) : raw;
    const label = isHtml ? " (已转为 Markdown)" : "";
    return `HTTP ${res.status}${label}\n\n${truncate(body)}`;
  },
};

// 工具 6：执行 shell 命令。
// ⚠️ TODO: 这是最危险的工具——可执行任意命令。生产环境必须加沙箱 / 命令白名单 /
//          人工确认；本学习项目仅做最简实现并加 30s 超时防卡死。
export const shellTool: Tool = {
  name: "shell",
  description: "执行一条 shell 命令，返回 stdout 和 stderr。",
  dangerous: true, // 能执行任意命令，最危险 → 需确认
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
  },
  async run(input, ctx) {
    const command = String(input.command ?? "");
    try {
      // signal：用户 Ctrl+C 时 kill 子进程；timeout：命令自身的 30s 上限。
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30_000,
        signal: ctx?.signal,
      });
      return truncate([stdout, stderr].filter(Boolean).join("\n").trim() || "（无输出）");
    } catch (err) {
      // 非 0 退出 / 超时：把退出码和输出一并返回，交给 Agent 转成 is_error。
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      const detail = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`命令失败（退出码 ${e.code ?? "?"}）：${detail || e.message}`);
    }
  },
};

// 默认工具集：CLI 直接用这一组。
export const defaultTools: Tool[] = [
  getCurrentTime,
  calculator,
  readFileTool,
  writeFileTool,
  editFileTool, // 第19步:精确编辑(字符串替换 + read-before-edit)
  httpRequestTool,
  shellTool,
  todoWriteTool, // 第14步:任务规划(无状态 todo 清单,见 src/todo.ts)
];
