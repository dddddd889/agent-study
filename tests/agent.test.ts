import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import type { Tool } from "../src/types";
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

describe("Agent 工具调用循环", () => {
  // 一个加法工具，记录被调用的参数，便于断言。
  function makeAddTool(): { tool: Tool; calls: unknown[] } {
    const calls: unknown[] = [];
    const tool: Tool = {
      name: "add",
      description: "把两个数相加",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      run: (input) => {
        calls.push(input);
        return String((input.a as number) + (input.b as number));
      },
    };
    return { tool, calls };
  }

  test("模型请求工具 -> 执行 -> 结果喂回 -> 得到最终答复", async () => {
    const { tool, calls } = makeAddTool();
    let step = 0;
    const llm = new FakeLLM(() => {
      step++;
      // 第一次：要求调用 add(2,3)；第二次：给出最终文本。
      if (step === 1) {
        return {
          stopReason: "tool_use",
          content: [
            { type: "tool_use", id: "t1", name: "add", input: { a: 2, b: 3 } },
          ],
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "等于 5" }] };
    });
    const agent = new Agent(llm, { tools: [tool] });

    const reply = await agent.send("2+3 等于几");

    expect(reply).toBe("等于 5");
    expect(calls).toEqual([{ a: 2, b: 3 }]);

    // 历史应为：user / assistant(tool_use) / user(tool_result) / assistant(text)
    const history = agent.getHistory();
    expect(history).toHaveLength(4);
    expect(history[1]!.content).toEqual([
      { type: "tool_use", id: "t1", name: "add", input: { a: 2, b: 3 } },
    ]);
    expect(history[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "5", is_error: false },
    ]);

    // 第二次调模型时，能看到工具结果（让 agent “知道之前每一步发生了什么”）。
    expect(llm.calls[1]!.messages).toHaveLength(3);
  });

  test("未知工具返回 is_error 结果块，并把错误喂回模型", async () => {
    let step = 0;
    const llm = new FakeLLM(() => {
      step++;
      if (step === 1) {
        return {
          stopReason: "tool_use",
          content: [
            { type: "tool_use", id: "x", name: "不存在", input: {} },
          ],
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "抱歉" }] };
    });
    const agent = new Agent(llm, { tools: [] });

    const reply = await agent.send("用个工具");

    expect(reply).toBe("抱歉");
    const history = agent.getHistory();
    expect(history[2]!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "x",
        content: "未知工具: 不存在",
        is_error: true,
      },
    ]);
  });

  test("工具抛错被捕获成 is_error，不中断对话", async () => {
    const tool: Tool = {
      name: "boom",
      description: "总是抛错",
      inputSchema: { type: "object", properties: {} },
      run: () => {
        throw new Error("炸了");
      },
    };
    let step = 0;
    const llm = new FakeLLM(() => {
      step++;
      if (step === 1) {
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "b", name: "boom", input: {} }],
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
    const agent = new Agent(llm, { tools: [tool] });

    const reply = await agent.send("调用 boom");

    expect(reply).toBe("好的");
    const result = agent.getHistory()[2]!.content;
    expect(result).toEqual([
      { type: "tool_result", tool_use_id: "b", content: "炸了", is_error: true },
    ]);
  });

  test("超过 maxSteps 抛错，防止死循环", async () => {
    const tool: Tool = {
      name: "noop",
      description: "空操作",
      inputSchema: { type: "object", properties: {} },
      run: () => "ok",
    };
    // 模型永远要求调用工具，触发上限保护。
    const llm = new FakeLLM(() => ({
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "n", name: "noop", input: {} }],
    }));
    const agent = new Agent(llm, { tools: [tool], maxSteps: 3 });

    await expect(agent.send("转圈")).rejects.toThrow(/最大工具调用步数/);
    expect(llm.calls).toHaveLength(3);
  });

  test("stop_reason 为 max_tokens 时抛出清晰错误，而非空转", async () => {
    // 模型返回一个被截断的工具调用（参数残缺）+ max_tokens。
    const llm = new FakeLLM(() => ({
      stopReason: "max_tokens",
      content: [
        { type: "tool_use", id: "t1", name: "write_file", input: { path: "x" } },
      ],
    }));
    const agent = new Agent(llm, { tools: [] });

    await expect(agent.send("写个大文件")).rejects.toThrow(/max_tokens/);
    // 只调用了一次模型就报错，没有进入空转循环。
    expect(llm.calls).toHaveLength(1);
  });

  test("onTextDelta 收到模型回复的文本增量", async () => {
    const llm = new FakeLLM(() => "你好世界");
    const chunks: string[] = [];
    const agent = new Agent(llm, { onTextDelta: (t) => chunks.push(t) });

    const reply = await agent.send("hi");

    expect(reply).toBe("你好世界");
    expect(chunks.join("")).toBe("你好世界"); // 增量拼起来 = 最终回复
  });

  test("历史超过 maxContextTokens 时按轮截断，并触发 onTruncate", async () => {
    const llm = new FakeLLM();
    const events: Array<{ droppedTurns: number }> = [];
    const agent = new Agent(llm, {
      maxContextTokens: 30, // 很小，强制截断
      onTruncate: (info) => events.push(info),
    });

    for (let i = 1; i <= 6; i++) {
      await agent.send(`这是第${i}句话，用来把上下文撑长一点`);
    }

    const h = agent.getHistory();
    expect(h.length).toBeLessThan(12); // 没有无限增长
    expect(h[0]!.role).toBe("user");
    expect(typeof h[0]!.content).toBe("string"); // 首条是真实用户输入
    expect(events.length).toBeGreaterThan(0); // 至少截断过一次

    // 最近一次调用 LLM 时，收到的就是截断后的短历史。
    const lastCall = llm.calls[llm.calls.length - 1]!;
    expect(lastCall.messages.length).toBeLessThan(12);
  });

  test("onToolCall / onToolResult 回调会被触发", async () => {
    const { tool } = makeAddTool();
    let step = 0;
    const llm = new FakeLLM(() => {
      step++;
      if (step === 1) {
        return {
          stopReason: "tool_use",
          content: [
            { type: "tool_use", id: "t1", name: "add", input: { a: 1, b: 1 } },
          ],
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "2" }] };
    });
    const events: string[] = [];
    const agent = new Agent(llm, {
      tools: [tool],
      onToolCall: ({ name }) => events.push(`call:${name}`),
      onToolResult: ({ name, content }) => events.push(`result:${name}:${content}`),
    });

    await agent.send("1+1");

    expect(events).toEqual(["call:add", "result:add:2"]);
  });
});
