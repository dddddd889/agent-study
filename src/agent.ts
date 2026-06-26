import type { LLM, Message } from "./types";

export interface AgentOptions {
  system?: string;
}

// 最简对话 Agent：维护一段对话历史，每轮把用户输入追加进去，
// 调用 LLM 得到回复，再把回复追加回历史，从而实现“多轮记忆”。
export class Agent {
  private llm: LLM;
  private system?: string;
  private history: Message[] = [];

  constructor(llm: LLM, opts: AgentOptions = {}) {
    this.llm = llm;
    this.system = opts.system;
  }

  // 这就是 agent 循环的“一轮”：输入一句话 -> 拿到一句回复。
  async send(userInput: string): Promise<string> {
    this.history.push({ role: "user", content: userInput });
    const reply = await this.llm.complete(this.history, this.system);
    this.history.push({ role: "assistant", content: reply });
    return reply;
  }

  // 返回历史副本，避免外部直接改内部数组。
  getHistory(): Message[] {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
  }
}
