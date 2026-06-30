// 一条对话消息的角色。最简循环里只有 user / assistant 两种角色。
export type Role = "user" | "assistant";

// ============ 内容块（content blocks）============
// Anthropic Messages API 的 content 既可以是一段纯文本字符串，
// 也可以是一个「内容块」数组。引入工具调用后，一条消息里可能同时包含
// 文本和工具调用，所以必须用数组形式来表达。

// 模型或用户输出的普通文本。
export interface TextBlock {
  type: "text";
  text: string;
}

// 模型请求调用某个工具（出现在 assistant 消息里）。
export interface ToolUseBlock {
  type: "tool_use";
  id: string; // 本次调用的唯一 id，结果要用它对应回来
  name: string; // 要调用的工具名
  input: Record<string, unknown>; // 模型给出的参数
}

// 工具执行结果（作为 user 消息回传给模型）。
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string; // 对应某个 ToolUseBlock.id
  content: string; // 工具返回的文本结果
  is_error?: boolean; // 执行出错时置 true，模型会据此调整
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// 一条对话消息：content 可以是简单字符串（纯文本场景），
// 也可以是内容块数组（涉及工具时）。两种形式 Anthropic API 都接受。
export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

// ============ 工具定义 ============
// 工具执行的上下文。用对象包装是为了可扩展（以后可加 onProgress / cwd 等）。
export interface ToolContext {
  // 中断信号：abort 后，会阻塞的工具（http / shell / 读写文件）应尽快停止。
  signal?: AbortSignal;
}

// 一个工具 = 给模型看的「说明书」(name/description/inputSchema)
//          + 本地真正执行的逻辑 (run)。
export interface Tool {
  name: string;
  description: string; // 写清楚“什么时候用它”，模型据此决定是否调用
  // 危险工具（碰文件系统 / 网络 / 进程）执行前需人工确认；纯计算工具为 false/省略。
  dangerous?: boolean;
  // 辅助工具（如 todo 记账）：本身不推进任务,调用它【不计入 maxSteps 步数预算】。
  // 否则「每步都更新 todo」会蚕食步数,让真正干活 + 收尾挤不进上限。见 docs/14。
  auxiliary?: boolean;
  // JSON Schema，描述参数结构，模型据此生成 input。
  inputSchema: Record<string, unknown>;
  // 实际执行：拿到模型给的参数（和可选上下文），返回文本结果（可异步）。
  run(
    input: Record<string, unknown>,
    ctx?: ToolContext,
  ): string | Promise<string>;
}

// ============ LLM 抽象 ============
// 引入工具后，单次回复不再只是一段文本：它可能包含 tool_use 块，
// 还需要 stopReason 来判断「是否要继续循环」。
export interface LLMResponse {
  // "end_turn" | "tool_use" | "max_tokens" | ...
  stopReason: string;
  // assistant 这一步产出的内容块（文本 + 可能的 tool_use）。
  content: ContentBlock[];
}

export interface CompleteOptions {
  system?: string;
  tools?: Tool[];
  // 中断信号：abort 后正在进行的 fetch/SSE 流会立即断开。
  signal?: AbortSignal;
}

// LLM 抽象接口：给定历史消息（和可选 system / tools），流式产出助手的下一步输出。
// 抽象成接口，是为了让 Agent 不依赖具体厂商，测试时可换成 FakeLLM。
//
// stream() 是异步生成器：
//   - yield 出「文本增量」(string)，供上层边到边显示；
//   - return 出组装好的完整 LLMResponse（文本 + 工具调用 + stopReason），
//     供 agent 循环判断是否继续。
// 不需要实时显示时，忽略 yield 的增量、只用 return 的结果即可。
export interface LLM {
  stream(
    messages: Message[],
    opts?: CompleteOptions,
  ): AsyncGenerator<string, LLMResponse>;
}
