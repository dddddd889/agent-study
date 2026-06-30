import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

// 工具 3：读取文件内容。
export const readFileTool: Tool = {
  name: "read_file",
  description: "读取一个文本文件的内容并返回（UTF-8）。",
  dangerous: true, // 能读到密钥/隐私文件，且可能被外发 → 需确认
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对路径相对于进程工作目录）" },
    },
    required: ["path"],
  },
  // TODO: 路径沙箱 —— 限制在工作目录内，防止路径穿越 / 越权读取（如 ../../etc/passwd）。
  async run(input, ctx) {
    const path = String(input.path ?? "");
    return truncate(await readFile(path, { encoding: "utf-8", signal: ctx?.signal }));
  },
};

// 工具 4：写入文件（覆盖写，自动创建父目录）。
export const writeFileTool: Tool = {
  name: "write_file",
  description: "把文本写入文件（覆盖已有内容，自动创建缺失的父目录）。",
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
    return `已写入 ${content.length} 个字符到 ${path}`;
  },
};

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
  httpRequestTool,
  shellTool,
  todoWriteTool, // 第14步:任务规划(无状态 todo 清单,见 src/todo.ts)
];
