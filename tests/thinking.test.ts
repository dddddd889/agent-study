import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { AnthropicLLM } from "../src/llm";
import { extractMemory } from "../src/memory";
import type { LLMResponse, Message, Tool } from "../src/types";
import { FakeLLM } from "./fake-llm";

const realFetch = globalThis.fetch;
const saved = {
  on: process.env.AGENT_THINKING,
  budget: process.env.AGENT_THINKING_BUDGET,
};
afterEach(() => {
  globalThis.fetch = realFetch;
  if (saved.on === undefined) delete process.env.AGENT_THINKING;
  else process.env.AGENT_THINKING = saved.on;
  if (saved.budget === undefined) delete process.env.AGENT_THINKING_BUDGET;
  else process.env.AGENT_THINKING_BUDGET = saved.budget;
});

// 捕获 complete() 的请求体。
function mockJson() {
  const cap: { body: any } = { body: null };
  globalThis.fetch = (async (_url: any, init: any) => {
    cap.body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return cap;
}

// 造 SSE 响应给 stream() 用。
function mockSSE(events: object[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  globalThis.fetch = (async () =>
    new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

// ============ buildBody:thinking 参数 ============
describe("扩展思考:请求体", () => {
  test("AGENT_THINKING=1 → body 带 thinking(enabled + budget)", async () => {
    process.env.AGENT_THINKING = "1";
    process.env.AGENT_THINKING_BUDGET = "12000";
    const cap = mockJson();
    await new AnthropicLLM({ authToken: "t" }).complete([{ role: "user", content: "hi" }]);
    expect(cap.body.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
  });

  test("默认关 → body 无 thinking", async () => {
    delete process.env.AGENT_THINKING;
    const cap = mockJson();
    await new AnthropicLLM({ authToken: "t" }).complete([{ role: "user", content: "hi" }]);
    expect(cap.body.thinking).toBeUndefined();
  });

  test("opts.thinking=false 覆盖 env 开启(内部调用不思考)", async () => {
    process.env.AGENT_THINKING = "1";
    const cap = mockJson();
    await new AnthropicLLM({ authToken: "t" }).complete([{ role: "user", content: "hi" }], { thinking: false });
    expect(cap.body.thinking).toBeUndefined();
  });

  test("budget≥max_tokens → 报错", async () => {
    process.env.AGENT_THINKING = "1";
    process.env.AGENT_THINKING_BUDGET = "16000";
    mockJson();
    const llm = new AnthropicLLM({ authToken: "t", maxTokens: 1000 });
    await expect(llm.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/必须小于 max_tokens/);
  });

  test("budget<1024 夹到 1024", async () => {
    process.env.AGENT_THINKING = "1";
    process.env.AGENT_THINKING_BUDGET = "500";
    const cap = mockJson();
    await new AnthropicLLM({ authToken: "t" }).complete([{ role: "user", content: "hi" }]);
    expect(cap.body.thinking.budget_tokens).toBe(1024);
  });
});

// ============ stream:解析思考块 ============
describe("扩展思考:流解析", () => {
  test("thinking 块入 content;正文走 onThinkingDelta 不 yield;答复只含 text", async () => {
    mockSSE([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我想想" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG123" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    ]);
    const llm = new AnthropicLLM({ authToken: "t" });
    const think: string[] = [];
    const yields: string[] = [];
    const gen = llm.stream([{ role: "user", content: "hi" }], { onThinkingDelta: (t) => think.push(t) });
    let step = await gen.next();
    while (!step.done) {
      yields.push(step.value);
      step = await gen.next();
    }
    const res = step.value;
    expect(think.join("")).toBe("让我想想"); // 思考走回调
    expect(yields.join("")).toBe("答案"); // yield 只有答复,不含思考
    // content 保真:思考块(带签名) + 文本块
    expect(res.content[0]).toEqual({ type: "thinking", thinking: "让我想想", signature: "SIG123" });
    expect(res.content[1]).toEqual({ type: "text", text: "答案" });
  });
});

// ============ 历史保真:带工具调用的轮保留思考块 ============
describe("扩展思考:历史保真", () => {
  test("工具调用轮的 assistant 消息保留思考块(原样入历史)", async () => {
    const tool: Tool = {
      name: "noop",
      description: "x",
      category: "read",
      inputSchema: { type: "object", properties: {} },
      run: () => "done",
    };
    let n = 0;
    const llm = new FakeLLM((): LLMResponse => {
      n++;
      if (n === 1) {
        return {
          stopReason: "tool_use",
          content: [
            { type: "thinking", thinking: "先想一下", signature: "S" },
            { type: "tool_use", id: "t1", name: "noop", input: {} },
          ],
        };
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: "好了" }] };
    });
    const agent = new Agent(llm, { tools: [tool] });
    const reply = await agent.send("go");
    expect(reply).toBe("好了"); // 答复只含 text
    const assistant = agent.getHistory()[1]!; // user, assistant(tool_use), ...
    const blocks = assistant.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "先想一下", signature: "S" }); // 思考块原样在历史里
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);
  });
});

// ============ 长期记忆:抽取时剔除思考块 ============
describe("扩展思考:记忆抽取剔除思考块", () => {
  test("抽取 prompt 不含思考正文/签名", async () => {
    let capturedPrompt = "";
    const llm = new FakeLLM((messages: Message[]) => {
      capturedPrompt = typeof messages[0]!.content === "string" ? messages[0]!.content : "";
      return "记忆";
    });
    const history: Message[] = [
      { role: "user", content: "你好" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "机密推理", signature: "SECRETSIG" },
          { type: "text", text: "回答" },
        ],
      },
    ];
    await extractMemory(llm, history, "");
    expect(capturedPrompt).not.toContain("SECRETSIG"); // 签名不进记忆
    expect(capturedPrompt).not.toContain("机密推理"); // 思考正文不进记忆
    expect(capturedPrompt).toContain("回答"); // 答复正文仍在
  });
});
