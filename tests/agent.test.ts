import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { FakeLLM } from "./fake-llm";

describe("Agent 对话循环", () => {
  test("单轮：返回 LLM 的回复", async () => {
    const llm = new FakeLLM(() => "你好");
    const agent = new Agent(llm);

    const reply = await agent.send("hi");

    expect(reply).toBe("你好");
  });

  test("历史累积：每轮都把 user 和 assistant 追加进历史", async () => {
    const llm = new FakeLLM();
    const agent = new Agent(llm);

    await agent.send("第一句");
    await agent.send("第二句");

    const history = agent.getHistory();
    expect(history).toEqual([
      { role: "user", content: "第一句" },
      { role: "assistant", content: "echo#1:第一句" },
      { role: "user", content: "第二句" },
      { role: "assistant", content: "echo#2:第二句" },
    ]);
  });

  test("多轮记忆：第二轮调用 LLM 时能看到前面的全部历史", async () => {
    const llm = new FakeLLM();
    const agent = new Agent(llm);

    await agent.send("a");
    await agent.send("b");

    // 第二次调用时，传给 LLM 的 messages 应包含：user a / assistant / user b
    const secondCall = llm.calls[1]!;
    expect(secondCall.messages).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "echo#1:a" },
      { role: "user", content: "b" },
    ]);
  });

  test("system 提示会透传给 LLM", async () => {
    const llm = new FakeLLM();
    const agent = new Agent(llm, { system: "你是测试助手" });

    await agent.send("hi");

    expect(llm.calls[0]!.system).toBe("你是测试助手");
  });

  test("reset 清空历史", async () => {
    const llm = new FakeLLM();
    const agent = new Agent(llm);

    await agent.send("x");
    agent.reset();

    expect(agent.getHistory()).toEqual([]);
  });

  test("getHistory 返回副本，外部修改不影响内部状态", async () => {
    const llm = new FakeLLM();
    const agent = new Agent(llm);

    await agent.send("x");
    const h = agent.getHistory();
    h.push({ role: "user", content: "篡改" });

    expect(agent.getHistory()).toHaveLength(2);
  });
});
