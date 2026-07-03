import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { AnthropicLLM } from "../src/llm";
import { FakeLLM } from "./fake-llm";

const realFetch = globalThis.fetch;
const savedEnv = { cache: process.env.AGENT_CACHE, ttl: process.env.AGENT_CACHE_TTL };
afterEach(() => {
  globalThis.fetch = realFetch;
  // 还原 env,避免用例间串味。
  if (savedEnv.cache === undefined) delete process.env.AGENT_CACHE;
  else process.env.AGENT_CACHE = savedEnv.cache;
  if (savedEnv.ttl === undefined) delete process.env.AGENT_CACHE_TTL;
  else process.env.AGENT_CACHE_TTL = savedEnv.ttl;
});

// 捕获 complete() 的请求体(非流式,返回 JSON)。
function mockJson() {
  const captured: { body: any } = { body: null };
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return captured;
}

// 造一段 SSE 响应给 stream() 用(parseSSE 只认 data: 行)。
function mockSSE(events: object[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  globalThis.fetch = (async () =>
    new Response(text, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

describe("提示词缓存:buildBody 挂 cache_control", () => {
  test("默认开启:system 数组化 + 最后 message 末块都带 cache_control", async () => {
    const cap = mockJson();
    const llm = new AnthropicLLM({ authToken: "t" });
    await llm.complete([{ role: "user", content: "hi" }], { system: "sys" });
    expect(cap.body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(cap.body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
  });

  test("AGENT_CACHE=0 关闭:system 仍是字符串、message 无 cache_control", async () => {
    process.env.AGENT_CACHE = "0";
    const cap = mockJson();
    const llm = new AnthropicLLM({ authToken: "t" });
    await llm.complete([{ role: "user", content: "hi" }], { system: "sys" });
    expect(cap.body.system).toBe("sys");
    expect(cap.body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("AGENT_CACHE_TTL=1h:cache_control 带 ttl", async () => {
    process.env.AGENT_CACHE_TTL = "1h";
    const cap = mockJson();
    const llm = new AnthropicLLM({ authToken: "t" });
    await llm.complete([{ role: "user", content: "hi" }], { system: "sys" });
    expect(cap.body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("不改传入的 history:原消息对象/数组不被挂 cache_control", async () => {
    mockJson();
    const llm = new AnthropicLLM({ authToken: "t" });
    const history = [{ role: "user" as const, content: [{ type: "text" as const, text: "a" }] }];
    const snapshot = JSON.stringify(history);
    await llm.complete(history, { system: "sys" });
    expect(JSON.stringify(history)).toBe(snapshot); // 原对象原样,没被污染
  });
});

describe("提示词缓存:主/子 agent 用量分桶(子按 id 汇总)", () => {
  test("recordSubUsage 按 id 分列并累加同 id,不污染 main;reset 清空", () => {
    const agent = new Agent(new FakeLLM(), {});
    agent.recordSubUsage("a2f", { input: 5, output: 3, cacheRead: 10, cacheCreation: 2 });
    agent.recordSubUsage("7b3", { input: 1, output: 1, cacheRead: 4, cacheCreation: 0 });
    agent.recordSubUsage("a2f", { input: 0, output: 2, cacheRead: 6, cacheCreation: 1 }); // 同 id 累加

    const s = agent.contextStats();
    expect(s.usage.sub).toEqual([
      { id: "a2f", usage: { input: 5, output: 5, cacheRead: 16, cacheCreation: 3 } },
      { id: "7b3", usage: { input: 1, output: 1, cacheRead: 4, cacheCreation: 0 } },
    ]);
    expect(s.usage.main).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }); // 主桶不受影响

    agent.reset();
    expect(agent.contextStats().usage.sub).toEqual([]);
  });
});

describe("提示词缓存:stream 抓 usage", () => {
  test("从 message_start/message_delta 抓输入/缓存读写/输出", async () => {
    mockSSE([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 50,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
            output_tokens: 1,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ]);

    const llm = new AnthropicLLM({ authToken: "t" });
    const it = llm.stream([{ role: "user", content: "hi" }]);
    let step = await it.next();
    while (!step.done) step = await it.next();

    expect(step.value.usage).toEqual({
      input: 50,
      cacheRead: 1000,
      cacheCreation: 200,
      output: 42, // message_delta 的最终值覆盖 message_start 的初始 1
    });
  });

  test("正常读完【不】触发 onUsage(usage 随 return 交出,避免重复计费)", async () => {
    mockSSE([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    ]);

    const seen: unknown[] = [];
    const llm = new AnthropicLLM({ authToken: "t" });
    const it = llm.stream([{ role: "user", content: "hi" }], {
      onUsage: (u) => seen.push(u), // 只该在中断时触发
    });
    let step = await it.next();
    while (!step.done) step = await it.next();

    expect(seen).toHaveLength(0); // 正常路径:finally 里的 onUsage 不触发
    expect(step.value.usage?.output).toBe(9); // usage 仍随 return 交出
  });
});
