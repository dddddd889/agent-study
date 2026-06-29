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

  test("非 2xx 响应抛错", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const llm = new AnthropicLLM({ authToken: "t" });

    await expect(
      llm.complete([{ role: "user", content: "x" }]),
    ).rejects.toThrow(/500/);
  });
});
