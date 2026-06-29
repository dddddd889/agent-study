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
// calls 记录每次 complete 收到的参数，便于断言。
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

  async complete(
    messages: Message[],
    opts: CompleteOptions = {},
  ): Promise<LLMResponse> {
    // 存一份浅拷贝，避免后续历史变动影响断言。
    this.calls.push({
      messages: messages.map((m) => ({ ...m })),
      system: opts.system,
      tools: opts.tools,
    });
    const out = this.responder(messages, opts);
    // 允许 responder 直接返回字符串：包装成一段 end_turn 的纯文本回复。
    return typeof out === "string"
      ? { stopReason: "end_turn", content: [{ type: "text", text: out }] }
      : out;
  }
}
