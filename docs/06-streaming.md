# 第 6 步：流式输出(SSE)

> 前面几步,模型回复都是**等全部生成完**再一次性显示。这一步改成**边生成边显示**(打字机效果):请求走 SSE 流,文本一段段实时吐到终端。

## 一个关键认知:流式是"叠加",不是"替代"

[agent.ts](../src/agent.ts) 的工具循环依赖**完整的 `LLMResponse`**(`stopReason` + 组装好的 `content`)才能判断"要不要调工具/继续循环"。所以流式版本**最终仍要产出同一个 `LLMResponse`** —— 只是在生成过程中**额外**把文本增量实时吐出来。

> 一句话:**"拿到完整结果" 之上,叠加 "边到边显示"**。

## 业界怎么做(以及我们的选择)

每个 SDK 内部都解析**完整事件流**,对外提供两层视图:

- **全事件流(原语)**:Anthropic `messages.stream` 迭代原始事件、Vercel `fullStream`、OpenAI 的 chunk —— 含文本增量、**工具参数碎片**、思考增量、生命周期事件。
- **纯文本流(便利层)**:Vercel `textStream`、Anthropic `.on("text")` —— 只吐文本。

我们选**纯文本流**:对外只 yield 文本增量;工具调用在内部**静默组装**进最终 `LLMResponse`。理由:CLP 的核心收益是"回复边到边显示",而工具参数逐碎片显示(一串 JSON)价值很低却要引入事件联合类型。**内部其实解析了全部事件**(否则没法组装 `tool_use`、读 `stop_reason`),只是对外不暴露非文本的那些 —— "全事件流(`fullStream`)"留作 TODO。

## 接口形态:异步生成器([src/types.ts](../src/types.ts))

`LLM` 接口从 `complete()` 改成:

```ts
stream(messages, opts): AsyncGenerator<string, LLMResponse>
//                                      ^yield     ^return
```

- **yield** 文本增量(`string`)→ 实时显示;
- **return** 组装好的完整 `LLMResponse` → 驱动 agent 循环。

这等价于把 Vercel 的 `textStream` 和 `finalMessage()` **合二为一**:一个生成器既给增量、又给最终结果。

agent 循环这样消费(教学价值就在这几行):

```ts
const it = this.llm.stream(this.history, { system, tools });
let step = await it.next();
while (!step.done) {
  this.onTextDelta?.(step.value); // yield 出来的文本增量
  step = await it.next();
}
const res = step.value;            // done 时的 value = 组装好的 LLMResponse
// ……后续(max_tokens 检查 / 工具执行 / 继续循环)完全不变
```

`AnthropicLLM` 仍保留 `complete()`(非流式参考实现 + 现有测试用),不在接口里;`stream()` 是接口要求的唯一方法。

## SSE 解析与工具块组装([src/llm.ts](../src/llm.ts))

请求体加 `stream: true`,响应是 Server-Sent Events。我们关心这几类事件:

| 事件 | 作用 |
|---|---|
| `content_block_start` | 一个内容块开始(text 或 tool_use,带 id/name) |
| `content_block_delta` · `text_delta` | 文本增量 → **yield** 出去 |
| `content_block_delta` · `input_json_delta` | 工具参数的 **JSON 碎片** → 累积,先不 parse |
| `content_block_stop` | 块结束;若是 tool_use,把累积的 JSON 碎片 `JSON.parse` 成 `input` |
| `message_delta` | 带 `stop_reason` |
| `message_stop` | 流结束 |

**工具调用为什么要"攒齐再 parse"**:`tool_use` 的参数不是一次给全的,而是 `input_json_delta` 一段段来的(比如 `{"expr` + `ession":"1+1"}`)。必须累积到 `content_block_stop` 才是完整 JSON,才能 parse。

### 两个实现坑

1. **只重试连接,不重试流中途**:`stream()` 复用第 5 步的 `fetchWithRetry`,它只负责"连上、拿到 2xx"。一旦开始读流,中途断开**不重试**(因为可能已经吐了部分文本,重发会重复)。"断流续传"很复杂,留作 TODO。
2. **跨 chunk 的半行**:网络分块(chunk)边界和 SSE 行边界**无关** —— 一个 `data:` 行可能被拆到两个 chunk。解析器必须用 `buffer` 缓冲未结束的半行,收到换行才处理。SSE 解析最容易死在这上面。

## CLI 显示([src/cli.ts](../src/cli.ts))

- 传 `onTextDelta: (t) => process.stdout.write(t)` —— **裸写、不加换行**。
- 发送前打印前缀 `AI > `,`send()` 结束后补换行;**不再打印返回值**(否则和流式内容重复)。
- 工具/重试/截断这些回调行加**前导 `\n`**,免得和正在流的文本黏在一行。

### 两个交互细节(容易被当成 bug)

1. **回合期间暂停输入(`rl.pause()` / `rl.resume()`)**。`await send()` 可能跑好几秒,这期间 readline 仍在监听 stdin。如果用户**在 AI 回复时抢着打字/回车**,输入会被缓冲、并和流式输出交错。所以回合开始 `rl.pause()`、结束(`finally`)`rl.resume()`,全程只在回合末调一次 `rl.prompt()`。

   > 顺带澄清一个常见误解:提示符 `你 >` **只由 `rl.prompt()` 打印,而它只在 `send()` 返回后才调用**。所以看到 `你 >` 就代表这一轮真的结束了 —— 它不会插进回答中间。若它"看起来"出现在答案中途,真正原因是**模型那一步直接 `end_turn` 收场了**(见下一条),不是提示符放错位置。

2. **空回合提示**。模型有时以 `end_turn` 收场却**没产出任何文本**(常见于工具失败后直接放弃,例如 `http_request` 撞上自签名证书)。此时 `send()` 返回空串,CLI 会补一句 `(本轮无文本输出，可能是工具失败后模型未给结论)`,免得"静默结束"看起来像卡住或被截断。

## 测试(`bun test`)

全部离线(mock `fetch` 返回带 SSE body 的 `Response`):

- **文本流**:增量按序 yield、拼接正确、最终 `LLMResponse`(文本 + `stopReason`)正确;
- **工具组装**:`input_json_delta` 碎片还原成完整 `input`、`tool_use` 进最终 `content` 且**不混进**文本增量;
- **流式也走重试**:初始 502、重试后返回 SSE → 成功;
- **跨 chunk 半行**:把 SSE 从中间切成两个 chunk,验证解析器缓冲拼行;
- **agent**:`onTextDelta` 收到的增量拼起来 = 最终回复。

`FakeLLM` 也改成实现 `stream()`(把最终文本作为一段增量 yield、再 return `LLMResponse`),所以现有 agent 测试经它继续覆盖。

## 留下的 TODO

1. **全事件流(`fullStream`)**:对外多 yield 几种事件(工具开始/参数碎片/思考),支持更丰富的 UI
2. **断流续传**:流中途断开时基于已收内容续接,而非整轮重来
3. 配合大输出:流式天然规避了"非流式 >16k 易超时"的问题,可放心调大 `max_tokens`

## 下一步

1. **持久化**:把 `history` 存盘,跨进程续聊
2. **摘要压缩**:上下文管理从"截断"升级为"先摘要再丢"
