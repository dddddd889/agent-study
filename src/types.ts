// 一条对话消息。最简循环里只有 user / assistant 两种角色。
export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

// LLM 抽象接口：给定历史消息（和可选 system 提示），返回助手的下一句回复。
// 把它抽象成接口，是为了让 Agent 不依赖具体厂商，测试时可换成 FakeLLM。
export interface LLM {
  complete(messages: Message[], system?: string): Promise<string>;
}
