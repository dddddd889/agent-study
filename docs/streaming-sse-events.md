# 参考：流式 SSE 的事件与增量类型（Anthropic Messages API）

> 这是一篇**参考/深入**文档（非步骤），拆解 [src/llm.ts](../src/llm.ts) 里 `stream()` 怎么把 Anthropic 的 SSE 流解析成 `LLMResponse`。配合第 6 步（流式）、第 27 步（思考块）读。

## 两层：传输层 `parseSSE` vs 语义层 `switch`

解析分两层，职责分明：

- **`parseSSE`（传输层，"笨"的）**：只按 SSE 规矩把字节流切成事件——「空行 = 事件边界」，把每个 `data:` 行的 JSON `yield` 出来。它**不认识任何事件类型**，只吐 JSON 对象（对象自带 `type` 字段）。`event:` / `id:` / `:comment` 行一律忽略。
  - 一个关键细节：**网络分块(chunk)边界和事件边界无关**，一行可能被拆到两个 chunk，所以用 `buffer` 缓冲未结束的半行，收到换行才处理。

- **`stream()` 的 `switch (evt.type)`（语义层）**：认识事件、按类型组装成内容块。「有哪些类型」都体现在这个 switch 里。

## 顶层事件类型（`evt.type`）

一次流式回复的事件序列大致是：`message_start` → （每个内容块：`content_block_start` → 若干 `content_block_delta` → `content_block_stop`）× N → `message_delta` → `message_stop`。

| 事件 | 处理 | 作用 |
|---|---|---|
| `message_start` | ✅ | 带初始 `usage`（输入 / 缓存读写 token） |
| `content_block_start` | ✅ | 一个内容块开始（见下「块类型」） |
| `content_block_delta` | ✅ | 某个块的增量（见下「增量类型」） |
| `content_block_stop` | ✅ | 块结束（工具块在这里把累积的 JSON `parse` 掉） |
| `message_delta` | ✅ | 带 `stop_reason` + 最终 `output_tokens` |
| `message_stop` | ⚪ | 流结束标记，无需处理 |
| `ping` | ⚪ | 保活心跳，**有意忽略**（落默认分支 no-op，无害） |
| `error` | ❌ **未处理（真缺）** | 流**中途**报错，见文末「已知缺口」 |

## 块类型（`content_block_start` 的 `content_block.type`）

| 块类型 | 处理 | 说明 |
|---|---|---|
| `text` | ✅ | 答复正文 |
| `thinking` | ✅ | 扩展思考正文（第 27 步）;`signature` 随后由 delta 补齐 |
| `redacted_thinking` | ✅ | 加密思考块，**整块直接给 `data`**（无增量 delta），原样保真回传 |
| `tool_use` | ✅ | 工具调用;`id`/`name` 在 start，`input` 靠 delta 拼 |
| `server_tool_use` / `web_search_tool_result` | ❌ | 服务端工具（如网页搜索）——**没开就不会出现**，未用 |

## 增量类型（`content_block_delta` 的 `delta.type`）—— 即「内层 `d.type`」

`content_block_delta` 说「第 `evt.index` 个块又来一小片」，`d.type` 说这片是**哪种**增量，**和块类型配对**：

| 块类型 | 对应 `d.type` | 载荷字段 | 干嘛 |
|---|---|---|---|
| `text` | `text_delta` | `d.text` | 往文本块追加 |
| `tool_use` | `input_json_delta` | `d.partial_json` | 工具入参 JSON 的**碎片** |
| `thinking` | `thinking_delta` | `d.thinking` | 往思考块追加推理正文 |
| `thinking`（末尾） | `signature_delta` | `d.signature` | 思考块的签名（校验用） |
| （引用功能） | `citations_delta` | `d.citation` | ❌ 未开引用,未处理 |

> ⚠️ **载荷字段名不统一**：`text_delta→.text`、`thinking_delta→.thinking`、`signature_delta→.signature`、`input_json_delta→.partial_json`。不是统一的 `.value`——这是协议设计，代码里一一对着取。

## 两个关键机制

**1. `evt.index` = 块编号，把 delta 认领回它的块**
一次回复可能有多个块（如 `0` 思考、`1` 文本、`2` 工具）。每个块先 `content_block_start`、再若干带**同一 `index`** 的 `content_block_delta`、最后 `content_block_stop`。所以代码里到处是 `blocks[evt.index]`——按编号把增量拼回对应的块。

**2. 工具参数：累积后在 `stop` 才 `parse`**
`text`/`thinking` 是人读字符串，来一片追加一片、随时合法。但 `tool_use` 的入参是 **JSON**，碎片拼一半是**非法 JSON**（`{"path":"src/a`），没法边来边 parse。故 `input_json_delta` 先把碎片**当纯文本累积**进 `toolJson[index]`，等 `content_block_stop` 那一刻整段 `JSON.parse`。

## yield 什么、不 yield 什么

`stream()` 对外是 `AsyncGenerator<string, LLMResponse>`：**yield 出去的字符串 = 答复文本增量**（只有 `text_delta` 走 yield）。

- `thinking_delta`：走 `opts.onThinkingDelta` 回调（暗色显示），**不 yield**——否则思考会混进答复正文、进历史抽取（见第 27 步）。
- `input_json_delta` / `signature_delta`：静默累积进块，不 yield。
- 所有块最终组装进 `return` 的 `LLMResponse.content`。

## 已知缺口：`error` 事件被静默吞掉

流跑到一半，API 可能推：
```
event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
```
当前 `switch` **没有 `error` 分支** → 被默默丢弃 → 流"正常"结束、`return` 一个**残缺/空**的响应，上层毫不知情（不报错、不重试）。而 `fetchWithRetry` 只保证「连上、拿到 2xx」，**一旦开始读流就不再管**——所以流内 `error` 必须在 switch 里自己处理。

**建议**：加 `case "error"` → `throw`（让它像 HTTP 错误一样冒到上层，将来可纳入重试）;`ping` 加个空 case 或注释说明「有意忽略」。（TODO，尚未实现。）

## 相关

- 第 6 步 · 流式输出 → [06-streaming.md](06-streaming.md)
- 第 27 步 · 扩展思考（thinking/signature/redacted 块）→ [27-extended-thinking.md](27-extended-thinking.md)
