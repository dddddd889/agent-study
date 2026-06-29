import { countTurns, estimateTokens, truncateHistory } from "./context";
import type {
  ContentBlock,
  LLM,
  Message,
  TextBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from "./types";

export interface AgentOptions {
  system?: string;
  tools?: Tool[];
  // 工具循环的最大步数，防止模型反复要工具陷入死循环。默认 10。
  maxSteps?: number;
  // 上下文管理：历史估算 token 超过此值时，按整轮截断最旧的对话。默认 100000。
  // 想观察截断效果，把它调小（如 500）即可。
  maxContextTokens?: number;
  // 模型回复的文本增量回调，便于 CLI 边生成边显示（流式）。
  onTextDelta?: (text: string) => void;
  // 可选事件回调，便于 CLI 展示「正在调用工具 / 工具结果」等过程。
  onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
  onToolResult?: (result: {
    name: string;
    content: string;
    isError: boolean;
  }) => void;
  // 上下文被截断时触发，便于 CLI 显示「agent 遗忘了旧对话」。
  onTruncate?: (info: {
    droppedTurns: number;
    beforeTokens: number;
    afterTokens: number;
  }) => void;
}

// 带工具调用循环的 Agent。
// 相比最简对话循环，核心变化是：send() 不再「一问一答」，而是一个循环——
// 调模型 -> 若模型要用工具就执行 -> 把结果喂回历史 -> 再调模型 -> ...
// 直到模型不再要工具、给出最终答复。历史里会完整累积每一步的
// tool_use 和 tool_result，所以模型始终“知道之前每一步发生了什么”。
export class Agent {
  private llm: LLM;
  private system?: string;
  private tools: Tool[];
  private maxSteps: number;
  private maxContextTokens: number;
  private onTextDelta?: AgentOptions["onTextDelta"];
  private onToolCall?: AgentOptions["onToolCall"];
  private onToolResult?: AgentOptions["onToolResult"];
  private onTruncate?: AgentOptions["onTruncate"];
  private history: Message[] = [];

  constructor(llm: LLM, opts: AgentOptions = {}) {
    this.llm = llm;
    this.system = opts.system;
    this.tools = opts.tools ?? [];
    this.maxSteps = opts.maxSteps ?? 10;
    this.maxContextTokens = opts.maxContextTokens ?? 100000;
    this.onTextDelta = opts.onTextDelta;
    this.onToolCall = opts.onToolCall;
    this.onToolResult = opts.onToolResult;
    this.onTruncate = opts.onTruncate;
  }

  // 一轮对话（内部可能包含多步工具调用），返回最终的文本回复。
  async send(userInput: string): Promise<string> {
    this.history.push({ role: "user", content: userInput });

    // agent 循环：每次迭代 = 调一次模型。
    for (let step = 0; step < this.maxSteps; step++) {
      // 调模型前先做上下文管理：历史过长就按整轮截断最旧的对话。
      // 放在循环顶部，是因为工具循环里 history 还会增长，每轮都校一次最稳。
      this.compactHistory();

      // 消费流式生成器：yield 的是文本增量(实时显示)，done 时的 value 是
      // 组装好的完整 LLMResponse(后续逻辑照常用它)。
      const it = this.llm.stream(this.history, {
        system: this.system,
        tools: this.tools,
      });
      let step = await it.next();
      while (!step.done) {
        this.onTextDelta?.(step.value);
        step = await it.next();
      }
      const res = step.value;

      // 被 max_tokens 截断 => 这次输出是残缺的（文本没写完，或工具调用的
      // 参数 JSON 被截断）。继续喂回去只会让循环空转，直接报清楚错，
      // 提示调大 ANTHROPIC_MAX_TOKENS。
      if (res.stopReason === "max_tokens") {
        throw new Error(
          "输出被 max_tokens 截断（内容或工具调用参数未生成完整）。" +
            "请调大 max_tokens（环境变量 ANTHROPIC_MAX_TOKENS，claude-sonnet-4-6 上限 64000）。",
        );
      }

      const toolUses = res.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      // 没有工具调用 => 这就是最终答复，结束循环。
      // 纯文本回复存成字符串，让历史更直观（与无工具场景保持一致）。
      if (toolUses.length === 0) {
        const text = this.extractText(res.content);
        this.history.push({ role: "assistant", content: text });
        return text;
      }

      // 有工具调用 => 完整存下这一步的内容块（含 tool_use，结果要靠它的 id 对应）。
      this.history.push({ role: "assistant", content: res.content });

      // 逐个执行工具，把结果收集成一条 user 消息（tool_result 块数组）。
      const results: ToolResultBlock[] = [];
      for (const call of toolUses) {
        this.onToolCall?.({ name: call.name, input: call.input });
        const { content, isError } = await this.runTool(call);
        this.onToolResult?.({ name: call.name, content, isError });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content,
          is_error: isError,
        });
      }
      this.history.push({ role: "user", content: results });
      // 继续下一轮：模型这次能看到工具结果，再决定下一步。
    }

    throw new Error(`超过最大工具调用步数（${this.maxSteps}），可能陷入循环`);
  }

  // 上下文管理：历史估算 token 超过 maxContextTokens 时，按整轮截断最旧的对话。
  // TODO: 目前是「就地遗忘」—— this.history 被真删。如需保留完整历史，可改为
  //       保留完整历史、仅在发送时用截断副本，或把丢弃的旧轮归档到别处。
  // TODO: 截断之外还可做「摘要压缩」—— 把旧轮再调一次 LLM 浓缩成一段摘要塞回。
  private compactHistory(): void {
    const beforeTokens = estimateTokens(this.history);
    if (beforeTokens <= this.maxContextTokens) return;

    const truncated = truncateHistory(this.history, this.maxContextTokens);
    if (truncated.length === this.history.length) return; // 已是最近 1 轮，砍不动了

    const droppedTurns = countTurns(this.history) - countTurns(truncated);
    this.history = truncated;
    this.onTruncate?.({
      droppedTurns,
      beforeTokens,
      afterTokens: estimateTokens(truncated),
    });
  }

  // 执行单个工具调用，永远返回文本结果；出错也转成 is_error 结果块，
  // 让模型能看到错误信息并自行纠正，而不是直接抛断对话。
  private async runTool(
    call: ToolUseBlock,
  ): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      return { content: `未知工具: ${call.name}`, isError: true };
    }
    try {
      const out = await tool.run(call.input);
      return { content: String(out), isError: false };
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  }

  // 从内容块里抽取纯文本并拼接，作为最终回复字符串。
  private extractText(content: ContentBlock[]): string {
    return content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  // 返回历史副本，避免外部直接改内部数组。
  getHistory(): Message[] {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
  }
}
