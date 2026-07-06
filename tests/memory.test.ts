import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryUpdater,
  extractMemory,
  readMemory,
  writeMemory,
} from "../src/memory";
import type { CompleteOptions, LLMResponse, Message, Usage } from "../src/types";
import { FakeLLM } from "./fake-llm";

// 用临时文件隔离，避免动到真实 .memory.md。
const DIR = mkdtempSync(join(tmpdir(), "agent-memory-"));
process.env.AGENT_MEMORY_FILE = join(DIR, "mem.md");
beforeEach(() => {
  process.env.AGENT_MEMORY_FILE = join(DIR, "mem.md");
  if (existsSync(process.env.AGENT_MEMORY_FILE)) {
    rmSync(process.env.AGENT_MEMORY_FILE);
  }
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("memory 持久化", () => {
  test("不存在时 readMemory 返回空串", () => {
    expect(readMemory()).toBe("");
  });

  test("write → read 往返", () => {
    writeMemory("- 用户叫小明\n- 偏好蓝色");
    expect(readMemory()).toBe("- 用户叫小明\n- 偏好蓝色");
  });
});

describe("extractMemory（记忆 agent）", () => {
  test("据对话产出合并后的记忆文本", async () => {
    // FakeLLM 对「记忆请求」(system 含 "记忆") 返回固定的合并结果
    const llm = new FakeLLM((_messages, opts) =>
      opts.system?.includes("记忆") ? "- 用户叫小明\n- 偏好蓝色" : "好的",
    );

    const { memory } = await extractMemory(
      llm,
      [
        { role: "user", content: "我叫小明，喜欢蓝色" },
        { role: "assistant", content: "你好小明" },
      ],
      "", // 当前记忆为空
    );

    expect(memory).toBe("- 用户叫小明\n- 偏好蓝色");
  });
});

// ============ 记忆更新器(单飞 / flush 补跑 / 空值保护 / usage / 吞错自愈)============

const USAGE: Usage = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 };

// 把回复文本原样吐出、并带上可断言的 usage;next() 允许抛错以模拟抽取失败。
function makeLLM(next: () => string): FakeLLM {
  return new FakeLLM(
    (): LLMResponse => ({
      stopReason: "end_turn",
      content: [{ type: "text", text: next() }],
      usage: USAGE,
    }),
  );
}

// 可控延迟的 LLM:stream 在产出前等 gate 兑现,用来把抽取「按住在飞」以测单飞。
class GatedLLM extends FakeLLM {
  constructor(
    private gate: Promise<void>,
    private text: string,
  ) {
    super();
  }
  async *stream(
    messages: Message[],
    opts: CompleteOptions = {},
  ): AsyncGenerator<string, LLMResponse> {
    this.calls.push({
      messages: messages.map((m) => ({ ...m })),
      system: opts.system,
      tools: opts.tools,
    });
    await this.gate; // 按住:期间的 schedule 都会被单飞挡掉
    if (this.text) yield this.text;
    return {
      stopReason: "end_turn",
      content: [{ type: "text", text: this.text }],
      usage: USAGE,
    };
  }
}

// 逼平 fire-and-forget 的后台运行:轮转一次宏任务。
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createMemoryUpdater（记忆更新器）", () => {
  test("单飞:在飞时再 schedule 不发起第二次抽取", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new GatedLLM(gate, "记忆A");
    const u = createMemoryUpdater(
      llm,
      () => [],
      () => {},
    );

    u.schedule(); // 起第一次(被 gate 按住)
    await tick();
    u.schedule(); // 在飞 → 被单飞挡掉
    u.schedule();
    await tick();
    expect(llm.calls.length).toBe(1); // 只发起了一次

    release();
    await u.flush(); // 放行 + 因 pending 补跑一次
    expect(llm.calls.length).toBe(2);
  });

  test("flush 无 pending:不补跑", async () => {
    const llm = makeLLM(() => "记忆X");
    const u = createMemoryUpdater(
      llm,
      () => [],
      () => {},
    );

    u.schedule();
    await tick(); // 无 gate,立即跑完
    expect(llm.calls.length).toBe(1);

    await u.flush(); // 没有被挡过的新历史 → 不补跑
    expect(llm.calls.length).toBe(1);
  });

  test("flush 有 pending:补跑一次且读到最新历史(含被挡的轮)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let history: Message[] = [{ role: "user", content: "轮1" }];
    const llm = new GatedLLM(gate, "记忆");
    const u = createMemoryUpdater(
      llm,
      () => history,
      () => {},
    );

    u.schedule(); // 起第一次(按住),快照仅含「轮1」
    await tick();
    history = [
      { role: "user", content: "轮1" },
      { role: "user", content: "轮2" },
    ];
    u.schedule(); // 被挡 → pending=true(轮2 未覆盖)
    await tick();

    release();
    await u.flush(); // 补跑,读到含「轮2」的最新历史
    expect(llm.calls.length).toBe(2);
    const prompt = llm.calls[1]!.messages[0]!.content;
    expect(typeof prompt === "string" ? prompt : "").toContain("轮2");
  });

  test("空结果不覆盖:抽取返回空时保留已有记忆", async () => {
    writeMemory("旧记忆");
    const llm = makeLLM(() => ""); // 抽取产出空
    const u = createMemoryUpdater(
      llm,
      () => [{ role: "user", content: "x" }],
      () => {},
    );

    u.schedule();
    await tick();
    await u.flush();
    expect(readMemory()).toBe("旧记忆"); // 未被清空
  });

  test("usage 上报:onUsage 拿到本次抽取的 usage", async () => {
    const seen: Array<Usage | undefined> = [];
    const llm = makeLLM(() => "记忆");
    const u = createMemoryUpdater(
      llm,
      () => [],
      (usage) => seen.push(usage),
    );

    u.schedule();
    await tick();
    await u.flush();
    expect(seen[0]).toEqual(USAGE);
  });

  test("吞错自愈:抽取抛错不外泄,running 复位后仍能跑", async () => {
    let shouldThrow = true;
    const llm = makeLLM(() => {
      if (shouldThrow) throw new Error("boom");
      return "恢复后的记忆";
    });
    const u = createMemoryUpdater(
      llm,
      () => [{ role: "user", content: "x" }],
      () => {},
    );

    u.schedule(); // 第一次抛错(被吞)
    await tick();
    expect(existsSync(process.env.AGENT_MEMORY_FILE!)).toBe(false); // 没写成

    shouldThrow = false;
    u.schedule(); // running 已复位 → 能再起一次
    await tick();
    await u.flush();
    expect(readMemory()).toBe("恢复后的记忆"); // 自愈落盘
  });
});
