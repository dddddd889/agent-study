import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import type { LLM, Message, Tool } from "../src/types";
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

  test("onTurnComplete 正常结束时带本轮新增消息触发", async () => {
    const llm = new FakeLLM(() => "你好");
    const turns: Message[][] = [];
    const agent = new Agent(llm, { onTurnComplete: (added) => turns.push(added) });

    await agent.send("在吗");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual([
      { role: "user", content: "在吗" },
      { role: "assistant", content: "你好" },
    ]);
  });

  test("loadHistory 能恢复历史，续聊时模型看得到", async () => {
    const llm = new FakeLLM();
    const agent = new Agent(llm);
    agent.loadHistory([
      { role: "user", content: "我叫小明" },
      { role: "assistant", content: "你好小明" },
    ]);

    await agent.send("我叫什么");

    // 第二轮调用时，传给 LLM 的 messages 含恢复的历史
    expect(llm.calls[0]!.messages).toEqual([
      { role: "user", content: "我叫小明" },
      { role: "assistant", content: "你好小明" },
      { role: "user", content: "我叫什么" },
    ]);
  });

  test("中断封口（流式中）：保留半截文本 + 触发 onTurnComplete", async () => {
    // 一个边 yield 文本边等待 abort 的假 LLM
    const llm: LLM = {
      async *stream(_messages, opts) {
        yield "我正在";
        yield "回答";
        await new Promise((_r, rej) =>
          opts?.signal?.addEventListener("abort", () =>
            rej(new Error("aborted")),
          ),
        );
        return { stopReason: "end_turn", content: [] };
      },
    };
    const added: Message[][] = [];
    const agent = new Agent(llm, { onTurnComplete: (a) => added.push(a) });

    const ac = new AbortController();
    const p = agent.send("问题", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    await expect(p).rejects.toThrow();
    // 封口：用户提问 + 半截文本作为 assistant 消息
    expect(agent.getHistory()).toEqual([
      { role: "user", content: "问题" },
      { role: "assistant", content: "我正在回答" },
    ]);
    expect(added).toHaveLength(1); // 中断也触发了落盘回调
  });

  test("中断也计入 usage:onUsage 把半截花费记进主桶", async () => {
    // 模拟真实 stream():被中断时抛错,但在 finally 里通过 onUsage 吐出已产生的 usage。
    const llm: LLM = {
      async *stream(_messages, opts) {
        try {
          yield "半";
          await new Promise((_r, rej) =>
            opts?.signal?.addEventListener("abort", () =>
              rej(new Error("aborted")),
            ),
          );
          return { stopReason: "end_turn", content: [] };
        } finally {
          opts?.onUsage?.({ input: 12, output: 3, cacheRead: 0, cacheCreation: 0 });
        }
      },
    };
    const agent = new Agent(llm);

    const ac = new AbortController();
    const p = agent.send("问题", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toThrow();

    // 被中断这次调用烧掉的 token 仍进了主桶,而不是丢在地上。
    expect(agent.contextStats().usage.main).toEqual({
      input: 12,
      output: 3,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });

  test("中断封口（工具中）：给未完成 tool_use 补 is_error 取消结果", async () => {
    const hangTool: Tool = {
      name: "hang",
      description: "挂起直到被中断",
      inputSchema: { type: "object", properties: {} },
      run: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    };
    const llm = new FakeLLM(() => ({
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "h", name: "hang", input: {} }],
    }));
    const added: Message[][] = [];
    const agent = new Agent(llm, {
      tools: [hangTool],
      onTurnComplete: (a) => added.push(a),
    });

    const ac = new AbortController();
    const p = agent.send("go", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    await expect(p).rejects.toThrow();

    const h = agent.getHistory();
    // 封口：user / assistant(tool_use) / user(被中断的 tool_result)，结构合法
    expect(h).toHaveLength(3);
    expect(h[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "h", content: "[已被用户中断]", is_error: true },
    ]);
    expect(added).toHaveLength(1);
  });

  // 一个危险工具（每个用例自带 run 以便断言是否执行）。
  function dangerTool(run: () => string): Tool {
    return {
      name: "danger",
      description: "危险操作",
      category: "edit",
      inputSchema: { type: "object", properties: {} },
      run,
    };
  }
  // 让 FakeLLM 第一轮要 danger，第二轮 end_turn。
  function dangerThenDone() {
    let n = 0;
    return new FakeLLM(() => {
      n++;
      if (n === 1) {
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "d", name: "danger", input: {} }],
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
  }

  test("危险工具：onApprove 返回 once → 执行", async () => {
    let approvals = 0;
    const agent = new Agent(dangerThenDone(), {
      tools: [dangerTool(() => "done")],
      onApprove: async () => {
        approvals++;
        return "once";
      },
    });
    await agent.send("做危险操作");
    expect(approvals).toBe(1);
    // tool 被执行：历史里 tool_result 不是 is_error
    const result = agent.getHistory()[2]!.content as Array<{ is_error?: boolean }>;
    expect(result[0]!.is_error).toBe(false);
  });

  test("危险工具：deny → 不执行，喂回 is_error，对话继续", async () => {
    const ran: string[] = [];
    const reply = await new Agent(dangerThenDone(), {
      tools: [dangerTool(() => (ran.push("x"), "done"))],
      onApprove: async () => "deny",
    }).send("做危险操作");

    expect(ran).toHaveLength(0); // 没执行
    expect(reply).toBe("好的"); // 对话继续到 end_turn
  });

  test("危险工具：always → 后续同名工具不再弹问", async () => {
    const tool: Tool = {
      name: "danger",
      description: "危险",
      category: "edit",
      inputSchema: { type: "object", properties: {} },
      run: () => "ok",
    };
    // 连续两轮都要 danger，再 end_turn
    let n = 0;
    const llm = new FakeLLM(() => {
      n++;
      if (n <= 2)
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: `d${n}`, name: "danger", input: {} }],
        };
      return { stopReason: "end_turn", content: [{ type: "text", text: "完成" }] };
    });
    let approvals = 0;
    const agent = new Agent(llm, {
      tools: [tool],
      onApprove: async () => {
        approvals++;
        return "always";
      },
    });
    await agent.send("连做两次危险操作");
    expect(approvals).toBe(1); // 只在第一次弹问
  });

  test("没配 onApprove：危险工具默认拒绝（fail closed）", async () => {
    const tool: Tool = {
      name: "danger",
      description: "危险",
      category: "edit",
      inputSchema: { type: "object", properties: {} },
      run: () => "ok",
    };
    const ran: string[] = [];
    tool.run = () => {
      ran.push("x");
      return "ok";
    };
    await new Agent(dangerThenDone(), { tools: [tool] }).send("做危险操作");
    expect(ran).toHaveLength(0); // 默认拒绝，没执行
  });

  test("只读工具（无 category，默认 read）不触发 onApprove", async () => {
    const tool: Tool = {
      name: "safe",
      description: "安全",
      inputSchema: { type: "object", properties: {} },
      run: () => "ok",
    };
    let n = 0;
    const llm = new FakeLLM(() => {
      n++;
      if (n === 1)
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "s", name: "safe", input: {} }],
        };
      return { stopReason: "end_turn", content: [{ type: "text", text: "ok" }] };
    });
    let approvals = 0;
    await new Agent(llm, {
      tools: [tool],
      onApprove: async () => {
        approvals++;
        return "once";
      },
    }).send("用安全工具");
    expect(approvals).toBe(0);
  });

  test("onTextDelta 收到模型回复的文本增量", async () => {
    const llm = new FakeLLM(() => "你好世界");
    const chunks: string[] = [];
    const agent = new Agent(llm, { onTextDelta: (t) => chunks.push(t) });

    const reply = await agent.send("hi");

    expect(reply).toBe("你好世界");
    expect(chunks.join("")).toBe("你好世界"); // 增量拼起来 = 最终回复
  });

  // FakeLLM：对「摘要请求」(system 含 "摘要") 返回固定摘要，正常对话返回固定答复。
  function summarizerLLM() {
    return new FakeLLM((_messages, opts) => {
      if (opts.system?.includes("摘要")) return "这是旧对话的摘要";
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
  }

  test("超过 maxContextTokens：增量冻结旧轮、保留最近轮、触发 onCompact(freeze)", async () => {
    const events: Array<{ strategy: string }> = [];
    const agent = new Agent(summarizerLLM(), {
      maxContextTokens: 30, // 很小，强制压缩
      keepRecentTurns: 1,
      mergeBlockThreshold: 100, // 关掉合并,隔离增量冻结
      mergeZoneRatio: 100,
      onCompact: (info) => events.push(info),
    });

    for (let i = 1; i <= 5; i++) {
      await agent.send(`这是第${i}句话，用来把上下文撑长一点`);
    }

    expect(events.some((e) => e.strategy === "freeze")).toBe(true);
    // 压缩后历史以「摘要」消息开头
    const h = agent.getHistory();
    expect(typeof h[0]!.content).toBe("string");
    expect(h[0]!.content as string).toContain("[对话摘要]");
    expect(h[0]!.content as string).toContain("这是旧对话的摘要");
    expect(agent.contextStats().hasSummary).toBe(true);
  });

  test("压缩摘要输入剔除思考块（不泄露思考正文/signature，但保留 text）", async () => {
    const llm = summarizerLLM();
    const agent = new Agent(llm, {
      maxContextTokens: 30, // 很小，强制压缩
      keepRecentTurns: 1,
      mergeBlockThreshold: 100, // 关掉合并,隔离增量冻结
      mergeZoneRatio: 100,
    });
    // 注入含【思考块】的旧轮(模拟真实多步轮:thinking + text + tool_use / tool_result)。
    agent.loadHistory([
      { role: "user", content: "第一句很长的话用来把上下文撑长占位占位占位占位" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "秘密推理绝不该进摘要", signature: "SIG_BLOB_XYZ" },
          { type: "text", text: "我来查一下" },
          { type: "tool_use", id: "t1", name: "noop", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "结果", is_error: false }],
      },
      { role: "user", content: "第二句很长的话用来把上下文撑长占位占位占位占位" },
    ]);

    await agent.send("再来一句把上下文彻底撑爆占位占位占位占位"); // 触发压缩

    const summaryCalls = llm.calls.filter((c) => c.system?.includes("摘要"));
    expect(summaryCalls.length).toBeGreaterThan(0);
    const prompt = summaryCalls[0]!.messages[0]!.content as string;
    expect(prompt).not.toContain("SIG_BLOB_XYZ"); // signature 不泄露
    expect(prompt).not.toContain("秘密推理绝不该进摘要"); // 思考正文不泄露
    expect(prompt).toContain("我来查一下"); // 但 text 块保留
  });

  test("摘要调用失败 → 回退整轮截断，触发 onCompact(truncate)", async () => {
    const llm = new FakeLLM((_messages, opts) => {
      if (opts.system?.includes("摘要")) throw new Error("summarize failed");
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
    const events: Array<{ strategy: string }> = [];
    const agent = new Agent(llm, {
      maxContextTokens: 30,
      keepRecentTurns: 1,
      onCompact: (info) => events.push(info),
    });

    for (let i = 1; i <= 5; i++) {
      await agent.send(`这是第${i}句话，用来把上下文撑长一点`);
    }

    expect(events.some((e) => e.strategy === "truncate")).toBe(true);
    // 回退截断：历史不含摘要标记
    expect(agent.contextStats().hasSummary).toBe(false);
  });

  test("contextStats 返回当前上下文构成", async () => {
    const agent = new Agent(summarizerLLM());
    await agent.send("你好");
    const s = agent.contextStats();
    expect(s.messages).toBe(2);
    expect(s.turns).toBe(1);
    expect(s.hasSummary).toBe(false);
    expect(s.tokens).toBeGreaterThan(0);
  });

  // 记忆游标(docs/28)：每次摘要返回递增编号,便于验证「已冻结块不被重写」。
  function countingSummarizerLLM(failAfter = Infinity) {
    let n = 0;
    return new FakeLLM((_messages, opts) => {
      if (opts.system?.includes("摘要")) {
        n++;
        if (n > failAfter) throw new Error("summarize failed");
        return `摘要#${n}`;
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "好的" }] };
    });
  }
  // 数 history 开头连续的冻结块(以 [对话摘要] 开头的 user 字符串消息)。
  function leadingFrozen(h: Message[]): string[] {
    const out: string[] = [];
    for (const m of h) {
      if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[对话摘要]")) {
        out.push(m.content);
      } else break;
    }
    return out;
  }

  test("增量冻结：已冻结块跨多次压缩逐字不变（退化链断开）", async () => {
    const agent = new Agent(countingSummarizerLLM(), {
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 100, // 关合并,隔离增量冻结
      mergeZoneRatio: 100,
    });
    for (let i = 1; i <= 6; i++) await agent.send(`这是第${i}句话，用来把上下文撑长一点`);

    const blocks = leadingFrozen(agent.getHistory());
    expect(blocks.length).toBeGreaterThan(1); // 多块并存,不是单块被反复重摘
    // 第一块始终是「摘要#1」——从未被重新喂给模型改写
    expect(blocks[0]).toBe("[对话摘要]\n摘要#1");
    // 块按序累积、互不相同
    expect(blocks[1]).toBe("[对话摘要]\n摘要#2");
  });

  test("增量冻结：生成新块时把已冻结块作只读上下文喂入，但只输出新块", async () => {
    const llm = countingSummarizerLLM();
    const agent = new Agent(llm, {
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 100,
      mergeZoneRatio: 100,
    });
    for (let i = 1; i <= 5; i++) await agent.send(`这是第${i}句话，用来把上下文撑长一点`);

    // 摘要调用（system 含「摘要」）里,第 2 次及以后应带只读上下文 + 前一块文本。
    const summaryCalls = llm.calls.filter((c) => c.system?.includes("摘要"));
    expect(summaryCalls.length).toBeGreaterThan(1);
    const second = summaryCalls[1]!.messages[0]!.content as string;
    expect(second).toContain("只读上下文");
    expect(second).toContain("摘要#1"); // 前一块作为参考被喂入
  });

  test("合并：冻结块到阈值 → 塌成一块、计数归零、触发 onCompact(merge)", async () => {
    const events: Array<{ strategy: string; mergedBlocks?: number }> = [];
    const agent = new Agent(countingSummarizerLLM(), {
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 3, // 攒够 3 块就合并
      mergeZoneRatio: 100, // 占比阈值关掉,只看块数
      onCompact: (info) => events.push(info),
    });
    for (let i = 1; i <= 8; i++) await agent.send(`这是第${i}句话，用来把上下文撑长一点`);

    const merge = events.find((e) => e.strategy === "merge");
    expect(merge).toBeDefined();
    expect(merge!.mergedBlocks).toBe(3); // 3 块参与合并
    expect(events.some((e) => e.strategy === "freeze")).toBe(true); // 合并前先发生过冻结
  });

  test("可观测：contextStats 的冻结块数/游标随压缩更新", async () => {
    const agent = new Agent(countingSummarizerLLM(), {
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 100,
      mergeZoneRatio: 100,
    });
    expect(agent.contextStats().frozenBlocks).toBe(0); // 起始无冻结块
    expect(agent.contextStats().cursor).toBe(0);

    for (let i = 1; i <= 5; i++) await agent.send(`这是第${i}句话，用来把上下文撑长一点`);

    const s = agent.contextStats();
    expect(s.frozenBlocks).toBeGreaterThan(0); // 压缩后有冻结块
    expect(s.frozenBlocks).toBe(leadingFrozen(agent.getHistory()).length); // 与实际块数一致
    expect(s.cursor).toBeGreaterThan(0); // 游标已前移
    expect(s.hasSummary).toBe(true);
  });

  test("续聊重建：frozenState 导出 → loadHistoryWithFrozen 恢复冻结块与游标", async () => {
    const a1 = new Agent(countingSummarizerLLM(), {
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 100,
      mergeZoneRatio: 100,
    });
    for (let i = 1; i <= 5; i++) await a1.send(`这是第${i}句话，用来把上下文撑长一点`);

    const state = a1.frozenState();
    expect(state.blocks.length).toBeGreaterThan(0);
    expect(state.cursors.length).toBe(state.blocks.length); // 一一对应

    // 新 agent 用 sidecar 状态 + 主流水尾巴重建(模拟续聊)。
    const a2 = new Agent(countingSummarizerLLM());
    const rest: Message[] = [{ role: "user", content: "续聊一句" }];
    a2.loadHistoryWithFrozen(state.blocks, state.cursors, rest);

    const s = a2.contextStats();
    expect(s.frozenBlocks).toBe(state.blocks.length);
    expect(s.cursor).toBe(state.cursors[state.cursors.length - 1]!);
    const h = a2.getHistory();
    // 冻结块原样在前、主流水尾巴逐字接上
    expect(h.slice(0, state.blocks.length).map((m) => m.content)).toEqual(state.blocks);
    expect(h[h.length - 1]!.content).toBe("续聊一句");
  });

  test("兜底：增量摘要失败 → 只截逐字轮，已冻结块不动", async () => {
    const events: Array<{ strategy: string }> = [];
    const agent = new Agent(countingSummarizerLLM(1), {
      // 第 1 次摘要成功(得到 摘要#1),之后一律失败
      maxContextTokens: 30,
      keepRecentTurns: 1,
      mergeBlockThreshold: 100,
      mergeZoneRatio: 100,
      onCompact: (info) => events.push(info),
    });
    for (let i = 1; i <= 6; i++) await agent.send(`这是第${i}句话，用来把上下文撑长一点`);

    expect(events.some((e) => e.strategy === "truncate")).toBe(true); // 后续失败退截断
    // 冻结块「摘要#1」在多次截断后仍原样保留在最前
    expect(leadingFrozen(agent.getHistory())[0]).toBe("[对话摘要]\n摘要#1");
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
