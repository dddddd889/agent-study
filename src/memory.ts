import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { serializeForDistill } from "./context";
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
  // 蒸馏成文本喂给抽取:剔除思考块(草稿+签名,沉淀进记忆是污染+烧 token)、附件 ref 块转文字标记
  // (记忆是纯文本、看不见图,第29步)、【剔除 skill 正文】(dropSkill:true——skill 是流程指令,
  // 不该沉淀进长期记忆,第30步)。见 context.serializeForDistill、CONTEXT.md「三层蒸馏处置」。
  const transcript = serializeForDistill(history, { dropSkill: true });
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

// 记忆更新器(见 CONTEXT.md「长期记忆」):把长期记忆的后台更新【策略】收拢到一处 ——
// 单飞去重、空结果不覆盖、退出补跑。CLI 只管在每轮后 schedule()、退出前 flush(),
// 不再自持 memoryRunning / lastMemoryRun 这些裸状态,也不再重复退出补跑逻辑。
//
//   llm        : 抽取用的模型
//   getHistory : 取当前【全量】工作历史的快照函数(每次运行同步求值一次)
//   onUsage    : 后台照样烧 token —— 把每次抽取的 usage 报回去计入会话主用量
//
// 三个运行时状态都是本闭包私有的 let,进程内、会话级、不落盘:
//   running : 是否有抽取在飞(单飞闸门)
//   lastRun : 最近一次抽取的 promise(flush 先等它)
//   pending : 「有比在飞运行更新的历史没被覆盖」的脏标记(flush 据此决定补跑)
export function createMemoryUpdater(
  llm: LLM,
  getHistory: () => Message[],
  onUsage: (usage?: Usage) => void,
): { schedule: () => void; flush: () => Promise<void> } {
  let running = false;
  let lastRun: Promise<void> = Promise.resolve();
  let pending = false;

  // 一次抽取运行:开始即清 pending(这次会覆盖到当前全量历史);
  // getHistory() 在传参时同步求快照 —— 与 pending=false 同为同步、无竞态。
  const run = (): Promise<void> => {
    running = true;
    pending = false;
    lastRun = (async () => {
      try {
        const { memory: next, usage } = await extractMemory(
          llm,
          getHistory(),
          readMemory(),
        );
        if (next) writeMemory(next); // 空结果不覆盖,避免清空记忆
        onUsage(usage);
      } catch {
        // 后台失败:静默,不影响主对话
      } finally {
        running = false;
      }
    })();
    return lastRun;
  };

  // 每轮后调:有在飞的就记脏返回(单飞),否则起一次后台运行(不 await)。
  const schedule = (): void => {
    if (running) {
      pending = true;
      return;
    }
    void run();
  };

  // 退出前调:先等在飞的落定;若期间有被单飞挡掉的新历史(pending),
  // 再全量补一次 —— 一次抽取即可把连续挡掉的多轮一起纳入(读的是全量)。
  const flush = async (): Promise<void> => {
    await lastRun;
    if (pending) await run();
  };

  return { schedule, flush };
}
