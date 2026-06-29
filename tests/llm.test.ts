import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicLLM } from "../src/llm";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// 用一个假的 fetch 捕获请求，断言 URL / 头部 / body，无需真实网络。
function mockFetch() {
  const captured: { url: string; init: RequestInit } = {
    url: "",
    init: {},
  };
  globalThis.fetch = (async (url: any, init: any) => {
    captured.url = String(url);
    captured.init = init;
    return new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return captured;
}

describe("AnthropicLLM 请求构造", () => {
  test("使用 authToken 时走 Authorization Bearer，并拼接 baseUrl", async () => {
    const captured = mockFetch();
    const llm = new AnthropicLLM({
      authToken: "tok123",
      baseUrl: "https://proxy.example.com/",
      model: "claude-sonnet-4-6",
    });

    const res = await llm.complete([{ role: "user", content: "hi" }], {
      system: "sys",
    });

    expect(res.stopReason).toBe("end_turn");
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(captured.url).toBe("https://proxy.example.com/v1/messages");
    const headers = captured.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok123");
    expect(headers["x-api-key"]).toBeUndefined();

    const body = JSON.parse(captured.init.body as string);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("只有 apiKey 时走 x-api-key", async () => {
    const captured = mockFetch();
    // 清掉本机可能存在的 authToken / baseUrl 环境变量，避免它们抢占优先级，
    // 干扰本用例对 x-api-key 与默认 baseUrl 的断言。
    const saved = {
      tok: process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN,
      base: process.env.ECHO_TECH_ANTHROPIC_BASE_URL,
    };
    delete process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN;
    delete process.env.ECHO_TECH_ANTHROPIC_BASE_URL;
    try {
      const llm = new AnthropicLLM({ apiKey: "key123" });

      await llm.complete([{ role: "user", content: "hi" }]);

      const headers = captured.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("key123");
      expect(headers["authorization"]).toBeUndefined();
      expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      if (saved.tok !== undefined)
        process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN = saved.tok;
      if (saved.base !== undefined)
        process.env.ECHO_TECH_ANTHROPIC_BASE_URL = saved.base;
    }
  });

  test("缺少鉴权时构造阶段就报错", () => {
    // 临时清空环境变量，避免本机已配置的 token 干扰断言。
    const saved = {
      a: process.env.ANTHROPIC_API_KEY,
      b: process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN;
    try {
      expect(() => new AnthropicLLM()).toThrow();
    } finally {
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.b !== undefined)
        process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN = saved.b;
    }
  });

  test("传入 tools 时会序列化进请求体的 tools 字段", async () => {
    const captured = mockFetch();
    const llm = new AnthropicLLM({ authToken: "t" });

    await llm.complete([{ role: "user", content: "hi" }], {
      tools: [
        {
          name: "calc",
          description: "算术",
          inputSchema: { type: "object", properties: {} },
          run: () => "ok",
        },
      ],
    });

    const body = JSON.parse(captured.init.body as string);
    // 只发说明书三件套，本地的 run 不应出现在请求里。
    expect(body.tools).toEqual([
      {
        name: "calc",
        description: "算术",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  test("非 2xx 响应抛错（关闭重试）", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const llm = new AnthropicLLM({ authToken: "t", maxRetries: 0 });

    await expect(
      llm.complete([{ role: "user", content: "x" }]),
    ).rejects.toThrow(/500/);
  });
});

describe("AnthropicLLM 重试与退避", () => {
  // 返回一个 fetch 替身：按 makers 依次调用，每次产出一个全新的 Response
  // （Response body 只能读一次，不能复用同一个对象）。maker 抛异常即模拟网络错误。
  // 最后一个 maker 会被重复使用。retryBaseMs: 0 → 退避不真实等待，测试瞬间完成。
  function fetchSeq(makers: Array<() => Response>) {
    let i = 0;
    const calls = { count: 0 };
    globalThis.fetch = (async () => {
      calls.count++;
      const m = makers[Math.min(i, makers.length - 1)]!;
      i++;
      return m();
    }) as unknown as typeof fetch;
    return calls;
  }

  const ok = () =>
    new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
      { status: 200 },
    );

  test("502 后成功：重试一次拿到结果", async () => {
    const calls = fetchSeq([() => new Response("bad gateway", { status: 502 }), ok]);
    const llm = new AnthropicLLM({ authToken: "t", retryBaseMs: 0 });

    const res = await llm.complete([{ role: "user", content: "x" }]);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(calls.count).toBe(2); // 1 次失败 + 1 次重试成功
  });

  test("4xx 不重试：立刻抛错，只请求一次", async () => {
    const calls = fetchSeq([() => new Response("bad request", { status: 400 })]);
    const llm = new AnthropicLLM({ authToken: "t", retryBaseMs: 0 });

    await expect(
      llm.complete([{ role: "user", content: "x" }]),
    ).rejects.toThrow(/400/);
    expect(calls.count).toBe(1);
  });

  test("一直 5xx：耗尽重试后抛错，共 1 + maxRetries 次", async () => {
    const calls = fetchSeq([() => new Response("err", { status: 503 })]);
    const llm = new AnthropicLLM({ authToken: "t", retryBaseMs: 0, maxRetries: 3 });

    await expect(
      llm.complete([{ role: "user", content: "x" }]),
    ).rejects.toThrow(/503/);
    expect(calls.count).toBe(4); // 初始 1 + 重试 3
  });

  test("网络异常也重试", async () => {
    const calls = fetchSeq([
      () => {
        throw new Error("ECONNRESET");
      },
      ok,
    ]);
    const llm = new AnthropicLLM({ authToken: "t", retryBaseMs: 0 });

    const res = await llm.complete([{ role: "user", content: "x" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(calls.count).toBe(2);
  });

  test("onRetry 回调被触发，带状态码", async () => {
    fetchSeq([() => new Response("x", { status: 429 }), ok]);
    const events: Array<{ attempt: number; status?: number }> = [];
    const llm = new AnthropicLLM({
      authToken: "t",
      retryBaseMs: 0,
      onRetry: (info) => events.push({ attempt: info.attempt, status: info.status }),
    });

    await llm.complete([{ role: "user", content: "x" }]);
    expect(events).toEqual([{ attempt: 1, status: 429 }]);
  });

  test("尊重 Retry-After 头（秒数）", async () => {
    fetchSeq([
      () => new Response("x", { status: 429, headers: { "retry-after": "0" } }),
      ok,
    ]);
    let delay = -1;
    const llm = new AnthropicLLM({
      authToken: "t",
      retryBaseMs: 5000, // 若不尊重 Retry-After，退避会算出 ~5s
      onRetry: (info) => (delay = info.delayMs),
    });

    await llm.complete([{ role: "user", content: "x" }]);
    expect(delay).toBe(0); // 用了 Retry-After: 0，而非指数退避
  });
});
