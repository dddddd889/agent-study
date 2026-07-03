import { describe, expect, test } from "bun:test";
import { collectStream, extractText } from "../src/llm";
import type { LLMResponse } from "../src/types";

// 造一个和 LLM.stream 同形状的假生成器:yield 若干文本增量,return 一个 LLMResponse。
async function* fakeStream(
  deltas: string[],
  response: LLMResponse,
): AsyncGenerator<string, LLMResponse> {
  for (const d of deltas) yield d;
  return response;
}

const RES = (text: string): LLMResponse => ({
  stopReason: "end_turn",
  content: text ? [{ type: "text", text }] : [],
  usage: { input: 3, output: 5, cacheRead: 0, cacheCreation: 0 },
});

describe("collectStream（收流）", () => {
  test("静默收:拼接增量并回传 response", async () => {
    const { text, response } = await collectStream(
      fakeStream(["你好", "，", "小明"], RES("你好，小明")),
    );
    expect(text).toBe("你好，小明");
    expect(response.usage?.output).toBe(5); // usage 拿在手里,不再丢弃
  });

  test("空流兜底:没 yield 文本时从 content 的 text 块取", async () => {
    // 流一个字都没吐,但 return 的 content 里有 text 块 → text 走兜底
    const { text } = await collectStream(fakeStream([], RES("兜底文本")));
    expect(text).toBe("兜底文本");
  });

  test("边收边显示:onDelta 收到每个增量,顺序一致", async () => {
    const seen: string[] = [];
    const { text } = await collectStream(
      fakeStream(["a", "b", "c"], RES("abc")),
      (d) => seen.push(d),
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(text).toBe("abc");
  });

  test("收流不 trim:两端空白原样保留(trim 是调用点的事)", async () => {
    const { text } = await collectStream(fakeStream(["  hi  "], RES("  hi  ")));
    expect(text).toBe("  hi  ");
  });
});

describe("extractText", () => {
  test("只取 text 块、拼接,忽略非文本块", () => {
    expect(
      extractText([
        { type: "text", text: "前" },
        { type: "tool_use", id: "t1", name: "x", input: {} },
        { type: "text", text: "后" },
      ]),
    ).toBe("前后");
  });
});
