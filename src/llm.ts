import type {
  CompleteOptions,
  ContentBlock,
  LLM,
  LLMResponse,
  Message,
} from "./types";

export interface AnthropicLLMOptions {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
}

// 基于 Anthropic Messages API 的 LLM 实现。
// 只用了原生 fetch，没有额外 SDK 依赖，方便看清请求/响应结构。
//
// 鉴权两种方式（任选其一）：
//   1) x-api-key            <- ANTHROPIC_API_KEY，连官方 api.anthropic.com
//   2) Authorization Bearer <- ECHO_TECH_ANTHROPIC_AUTH_TOKEN，连自建/代理网关
// baseUrl 可用 ECHO_TECH_ANTHROPIC_BASE_URL 覆盖，指向代理地址。
export class AnthropicLLM implements LLM {
  private apiKey?: string;
  private authToken?: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;

  constructor(opts: AnthropicLLMOptions = {}) {
    this.authToken = opts.authToken ?? process.env.ECHO_TECH_ANTHROPIC_AUTH_TOKEN;
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!this.authToken && !this.apiKey) {
      throw new Error(
        "缺少鉴权：请配置 ECHO_TECH_ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY",
      );
    }

    const base =
      opts.baseUrl ??
      process.env.ECHO_TECH_ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com";
    // 去掉末尾斜杠，避免拼出双斜杠。
    this.baseUrl = base.replace(/\/+$/, "");
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    // max_tokens 是单次回复的上限。太小会把长输出（或把内容写进 write_file 的
    // tool_use 参数）截断，导致工具调用残缺、agent 循环空转。默认放到 8192，
    // 足够写个贪吃蛇；可用 ANTHROPIC_MAX_TOKENS 覆盖。
    this.maxTokens =
      opts.maxTokens ?? (Number(process.env.ANTHROPIC_MAX_TOKENS) || 8192);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    // 优先使用 bearer token（代理网关），否则回退到官方 x-api-key。
    if (this.authToken) {
      headers["authorization"] = `Bearer ${this.authToken}`;
    } else if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  async complete(
    messages: Message[],
    opts: CompleteOptions = {},
  ): Promise<LLMResponse> {
    const { system, tools } = opts;
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        // 把工具的「说明书」传给模型（run 是本地逻辑，不发给 API）。
        ...(tools && tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
        // content 直接透传：字符串或内容块数组（含 tool_use / tool_result）都合法。
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Anthropic API 错误 ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as {
      stop_reason: string;
      content: ContentBlock[];
    };

    // 把 stop_reason 和原始内容块（text / tool_use）交给上层。
    // 上层据 stop_reason 判断是否还要执行工具、继续循环。
    return {
      stopReason: data.stop_reason,
      content: data.content,
    };
  }
}
