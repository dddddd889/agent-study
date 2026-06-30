import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMemory, readMemory, writeMemory } from "../src/memory";
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

    const next = await extractMemory(
      llm,
      [
        { role: "user", content: "我叫小明，喜欢蓝色" },
        { role: "assistant", content: "你好小明" },
      ],
      "", // 当前记忆为空
    );

    expect(next).toBe("- 用户叫小明\n- 偏好蓝色");
  });
});
