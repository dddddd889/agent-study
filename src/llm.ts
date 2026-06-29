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
  // 重试：仅对「网络错误 / 429 / 5xx」重试，4xx 不重试。
  // maxRetries = 首次失败后额外重试的次数，默认 3（即最多 1 + 3 = 4 次请求）；0 表示不重试。
  maxRetries?: number;
  retryBaseMs?: number; // 指数退避基数(ms)，默认 500；测试可设 0 跳过真实等待。
  retryCapMs?: number; // 单次等待上限(ms)，默认 8000。
  // 每次重试前触发，便于上层(CLI)展示「正在重试」，库自身不打印。
  onRetry?: (info: {
    attempt: number; // 第几次重试（从 1 起）
    maxRetries: number;
    status?: number; // HTTP 状态码（网络错误时为 undefined）
    error?: Error; // 网络错误对象（HTTP 错误时为 undefined）
    delayMs: number; // 本次等待毫秒
  }) => void;
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
  private maxRetries: number;
  private retryBaseMs: number;
  private retryCapMs: number;
  private onRetry?: AnthropicLLMOptions["onRetry"];

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
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.retryCapMs = opts.retryCapMs ?? 8000;
    this.onRetry = opts.onRetry;
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
    const body = JSON.stringify({
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
    });

    const res = await this.fetchWithRetry(body);

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

  // 发请求并按需重试。返回的一定是 2xx 的 Response；否则抛错。
  // 可重试：网络异常 / 429 / 5xx；不可重试：4xx（请求本身的问题）。
  private async fetchWithRetry(body: string): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`;

    // attempt = 0 是初始请求，1..maxRetries 是重试。
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let networkErr: Error | undefined;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body,
        });
      } catch (err) {
        networkErr = err as Error;
      }

      if (res && res.ok) return res; // 成功

      const status = res?.status;
      const retryable =
        networkErr != null || status === 429 || (status != null && status >= 500);

      // 不可重试，或重试已耗尽 => 抛出最后一次的错误。
      if (!retryable || attempt >= this.maxRetries) {
        if (res) {
          const detail = await res.text();
          throw new Error(`Anthropic API 错误 ${res.status}: ${detail}`);
        }
        throw networkErr ?? new Error("请求失败");
      }

      // 计算等待：优先 Retry-After，否则指数退避；统一封顶 capMs。
      const retryAfter = res ? this.parseRetryAfter(res) : null;
      const delayMs = Math.min(
        retryAfter ?? this.backoffDelay(attempt + 1),
        this.retryCapMs,
      );

      this.onRetry?.({
        attempt: attempt + 1,
        maxRetries: this.maxRetries,
        status,
        error: networkErr,
        delayMs,
      });

      // 丢弃没读的响应体，避免连接泄漏。
      await res?.body?.cancel().catch(() => {});
      await sleep(delayMs);
    }
  }

  // 第 n 次重试前的指数退避 + 抖动：min(base * 2^(n-1), cap) + random(0, base)。
  private backoffDelay(n: number): number {
    const base = Math.min(this.retryBaseMs * 2 ** (n - 1), this.retryCapMs);
    const jitter = Math.random() * this.retryBaseMs;
    return base + jitter;
  }

  // 解析 Retry-After 头，返回毫秒；无或非法返回 null。
  // TODO: 仅支持秒数格式；HTTP 日期格式（"Wed, 21 Oct ... GMT"）暂不解析。
  private parseRetryAfter(res: Response): number | null {
    const h = res.headers.get("retry-after");
    if (h == null) return null;
    const secs = Number(h.trim());
    return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
