import type { LLM, Message } from "../src/types";

// 测试用的假 LLM：不发网络请求，方便离线 debug。
// records 记录每次 complete 收到的参数，便于断言。
export class FakeLLM implements LLM {
  public calls: Array<{ messages: Message[]; system?: string }> = [];
  private responder: (messages: Message[], system?: string) => string;

  // 默认行为：回显最后一条用户消息，并带上轮次编号。
  constructor(responder?: (messages: Message[], system?: string) => string) {
    this.responder =
      responder ??
      ((messages) => {
        const last = messages[messages.length - 1];
        const turn = messages.filter((m) => m.role === "user").length;
        return `echo#${turn}:${last?.content ?? ""}`;
      });
  }

  async complete(messages: Message[], system?: string): Promise<string> {
    // 存一份深拷贝，避免后续历史变动影响断言。
    this.calls.push({ messages: messages.map((m) => ({ ...m })), system });
    return this.responder(messages, system);
  }
}
