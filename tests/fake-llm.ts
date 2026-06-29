import type {
  CompleteOptions,
  LLM,
  LLMResponse,
  Message,
  Tool,
} from "../src/types";

// responder 可以返回一个完整的 LLMResponse（用于演练工具调用），
// 也可以图省事直接返回字符串，会被当作「end_turn 的纯文本回复」。
type Responder = (
  messages: Message[],
  opts: CompleteOptions,
) => string | LLMResponse;

// 测试用的假 LLM：不发网络请求，方便离线 debug。
// calls 记录每次 stream 收到的参数，便于断言。
export class FakeLLM implements LLM {
  public calls: Array<{
    messages: Message[];
    system?: string;
    tools?: Tool[];
  }> = [];
  private responder: Responder;

  // 默认行为：回显最后一条用户消息，并带上轮次编号。
  constructor(responder?: Responder) {
    this.responder =
      responder ??
      ((messages) => {
        const last = messages[messages.length - 1];
        const turn = messages.filter((m) => m.role === "user").length;
        const lastText = typeof last?.content === "string" ? last.content : "";
        return `echo#${turn}:${lastText}`;
      });
  }

  // 实现 LLM 接口的流式方法：把最终文本作为「一段增量」yield 出去，
  // 再 return 组装好的 LLMResponse。测试断言最终行为，不关心增量粒度。
  async *stream(
    messages: Message[],
    opts: CompleteOptions = {},
  ): AsyncGenerator<string, LLMResponse> {
    // 存一份浅拷贝，避免后续历史变动影响断言。
    this.calls.push({
      messages: messages.map((m) => ({ ...m })),
      system: opts.system,
      tools: opts.tools,
    });
    const out = this.responder(messages, opts);
    const res: LLMResponse =
      typeof out === "string"
        ? { stopReason: "end_turn", content: [{ type: "text", text: out }] }
        : out;

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (text) yield text;

    return res;
  }
}
