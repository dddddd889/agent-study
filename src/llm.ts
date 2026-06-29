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
    // max_tokens 是单次回复的输出上限。太小会把长输出（或把内容写进 write_file
    // 的 tool_use 参数）截断，导致工具调用残缺、agent 循环空转。
    // 默认直接拉满到 claude-sonnet-4-6 的输出上限 64000：
    //   - agent 走流式（stream()），大 max_tokens 不会触发非流式的 HTTP 超时；
    //   - max_tokens 只是上限，实际只按生成的 token 计费，调高没有额外成本。
    // 注意：这是 sonnet-4-6 的上限；opus / fable 可到 128000。换模型时可用
    // ANTHROPIC_MAX_TOKENS 覆盖。
    this.maxTokens =
      opts.maxTokens ?? (Number(process.env.ANTHROPIC_MAX_TOKENS) || 64000);
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

  // 拼请求体。stream=true 时让 API 走 SSE 流式返回。
  private buildBody(messages: Message[], opts: CompleteOptions, stream: boolean) {
    const { system, tools } = opts;
    return JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(stream ? { stream: true } : {}),
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
  }

  // 流式：yield 文本增量，return 组装好的完整 LLMResponse。
  // 内部解析「完整 SSE 事件流」，但对外只吐文本（工具调用静默组装进 return）。
  // TODO: 想暴露「全事件流」(fullStream，含工具参数碎片)时，再多 yield 几种事件即可。
  async *stream(
    messages: Message[],
    opts: CompleteOptions = {},
  ): AsyncGenerator<string, LLMResponse> {
    // fetchWithRetry 只负责「连上、拿到 2xx」；一旦开始读流，中途断不重试。
    const res = await this.fetchWithRetry(this.buildBody(messages, opts, true));
    if (!res.body) throw new Error("流式响应没有 body");

    const blocks: ContentBlock[] = [];
    const toolJson: string[] = []; // index -> 累积的 tool_use 参数 JSON 碎片
    let stopReason = "end_turn";

    for await (const evt of parseSSE(res.body)) {
      switch (evt.type) {
        case "content_block_start": {
          const cb = evt.content_block;
          if (cb.type === "text") {
            blocks[evt.index] = { type: "text", text: cb.text ?? "" };
          } else if (cb.type === "tool_use") {
            blocks[evt.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
            toolJson[evt.index] = "";
          }
          break;
        }
        case "content_block_delta": {
          const d = evt.delta;
          if (d.type === "text_delta") {
            const b = blocks[evt.index];
            if (b && b.type === "text") b.text += d.text;
            yield d.text; // 只把文本增量吐给上层显示
          } else if (d.type === "input_json_delta") {
            // 工具参数是逐碎片来的 JSON 文本，先累积，等块结束再 parse。
            toolJson[evt.index] = (toolJson[evt.index] ?? "") + (d.partial_json ?? "");
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks[evt.index];
          if (b && b.type === "tool_use") {
            const raw = toolJson[evt.index] ?? "";
            b.input = raw ? JSON.parse(raw) : {};
          }
          break;
        }
        case "message_delta": {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          break;
        }
        // message_start / message_stop 不需要特殊处理
      }
    }

    return { stopReason, content: blocks.filter(Boolean) };
  }

  // 非流式版本（保留作参考实现 + 现有测试用，不在 LLM 接口里）。
  async complete(
    messages: Message[],
    opts: CompleteOptions = {},
  ): Promise<LLMResponse> {
    const res = await this.fetchWithRetry(this.buildBody(messages, opts, false));
    const data = (await res.json()) as {
      stop_reason: string;
      content: ContentBlock[];
    };
    return { stopReason: data.stop_reason, content: data.content };
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

// 解析 Server-Sent Events 流,逐个 yield 出 data 行里的 JSON 对象。
// SSE 约定:每个事件由若干 `data:` 行组成,以空行结束;我们只关心 data 的 JSON
// (它自带 type 字段),忽略 `event:` 等其它字段。
// 关键:网络分块(chunk)边界和事件边界无关,一行可能被拆到两个 chunk —— 用 buffer
// 缓冲未结束的半行,直到收到换行才处理。
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = function* () {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    if (payload && payload !== "[DONE]") {
      try {
        yield JSON.parse(payload) as any;
      } catch {
        // 半个/损坏的 JSON 直接跳过
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1); // 兼容 CRLF

      if (line === "") {
        yield* flush(); // 空行 = 事件边界
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // 其它字段(event: / id: / :comment)忽略
    }
  }
  yield* flush(); // 末尾没有空行时也兜底处理
}
