import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { collectStream } from "./llm";
import type { LLM, Message, Usage } from "./types";

// 跨会话长期记忆:把对话里值得长期记住的「事实/偏好/决定」沉淀成一份全局记忆,
// 跨会话注入上下文(而不是塞原始历史流水)。
// 存成单个 Markdown 文件,默认 .memory.md;可用 AGENT_MEMORY_FILE 覆盖(测试隔离)。

function memoryFile(): string {
  return process.env.AGENT_MEMORY_FILE ?? ".memory.md";
}

export function readMemory(): string {
  const f = memoryFile();
  return existsSync(f) ? readFileSync(f, "utf-8").trim() : "";
}

export function writeMemory(text: string): void {
  writeFileSync(memoryFile(), text.trim() + "\n", "utf-8");
}

const MEMORY_SYSTEM =
  "你是长期记忆管理器。从对话中提取值得跨会话长期记住的【事实 / 偏好 / 决定】，" +
  "合并进已有记忆，去重、保持简洁，用要点(- )列出。" +
  "只输出更新后的【完整】记忆，不要寒暄或解释。";

// 「记忆 agent」:读 当前记忆 + 本次对话 → 输出合并去重后的完整记忆。
// 就是一个聚焦的 LLM 调用(无工具),收流取文本。由 CLI 在每轮后【后台】调用。
// 返回记忆文本 + 这次调用的 usage —— 后台照样烧 token,交给 CLI 计入会话主用量
// (别再像以前那样把 usage 丢在地上)。
export async function extractMemory(
  llm: LLM,
  history: Message[],
  current: string,
): Promise<{ memory: string; usage?: Usage }> {
  const transcript = history
    .map((m) => {
      // 第27步:剔除思考块——它是模型草稿(含被丢弃的假设 + 一大坨签名),
      // 沉淀进长期记忆是污染 + 烧 token;记忆只该记事实/偏好/决定。
      const text =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(
              m.content.filter(
                (b) => b.type !== "thinking" && b.type !== "redacted_thinking",
              ),
            );
      return `${m.role}: ${text}`;
    })
    .join("\n");
  const prompt =
    `已有长期记忆：\n${current || "(空)"}\n\n` +
    `本次对话：\n${transcript}\n\n` +
    `请输出更新后的【完整】长期记忆(要点列表)。`;

  // 记忆抽取是工具调用,不思考(省 token)。
  const it = llm.stream([{ role: "user", content: prompt }], {
    system: MEMORY_SYSTEM,
    thinking: false,
  });
  const { text, response } = await collectStream(it); // 静默收(含空流兜底)
  return { memory: text.trim(), usage: response.usage };
}
