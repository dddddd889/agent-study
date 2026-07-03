# 第 27 步：扩展思考（extended thinking）

> 让模型在给出答复前先输出一段**推理过程**（thinking），能显著提升复杂任务的质量。看似「加个请求参数」，实则牵四处：①请求参数、②流里解析思考块、③**把思考块原样存进历史并回传**、④展示。其中 **③历史保真**才是真难点。

## 四件套 + 默认关

| 环节 | 做了什么 |
|---|---|
| ①请求 | 开启时 body 加 `thinking:{type:"enabled",budget_tokens:N}`（[src/llm.ts](../src/llm.ts) `buildBody`） |
| ②解析 | `stream()` 认 `thinking` / `redacted_thinking` 内容块（`thinking_delta` 正文 + `signature_delta` 签名） |
| ③保真 | 思考块**原样含签名**存进 assistant 消息、回传不删（[src/agent.ts](../src/agent.ts)） |
| ④展示 | 思考正文经 `onThinkingDelta` **暗色 💭 流式**打印，不混进答复 |

**默认关**，`AGENT_THINKING=1` 开——思考费 token、仅部分模型支持，opt-in 更稳;关时 `buildBody` 不变，**不动现有测试**。

## ③ 历史保真——真正的难点

Anthropic 规则：**带工具调用的轮里，回传若缺思考块，API 直接 400**。所以思考块必须原样（含 `signature`）留在历史、下一次请求带上。我们的循环天然做对了：

- **工具调用轮**：`commit({role:"assistant", content: res.content})` 存**完整内容块数组**（含思考块）→ 下一轮连同 `tool_result` 一起回传 → API 满意。
- **最终答复轮**（end_turn）：`commit({content: extractText(...)})` 只存**文本**→ 思考块丢弃。这是**对的**：该轮已结束，其思考块不再需要，丢了还省 token。

策略取「**每轮都回传、从不删**」（最简正确）;「轮结束即 strip」的省 token 优化留 TODO。`redacted_thinking`（加密块）同样原样保真。

`extractText()` 只取 `text` 块 → 思考**天然不混进答复**，无需特判。

## ④ 展示走回调，不改 yield 契约

`stream()` 的 `yield string` = 答复文本增量。思考若也 yield 会**混进答复、进历史抽取**。故加 `onThinkingDelta` 回调单独走（`thinking_delta` 调它、**不 yield**）→ **FakeLLM 与现有流式测试零改动**。CLI 把思考以 ANSI 暗色（`\x1b[2m`，TTY 门控）流式打印，和答复正文视觉分开。

## 配置

- `AGENT_THINKING=1`：开启（默认关）。
- `AGENT_THINKING_BUDGET`：思考预算 token，默认 **16000**;`<1024` 夹到 1024;**`>=max_tokens` 报错**（思考占 `max_tokens` 的一部分，须留输出空间）。
- `AGENT_SUBAGENT_THINKING=0`：关掉子 agent 思考（并行省钱）。

## 交互（谁思考、谁不思考）

| 场景 | 思考？ | 怎么控 |
|---|---|---|
| 主 agent 生成 | 跟随 `AGENT_THINKING` | 主循环 stream 不传 `thinking` → 用实例默认 |
| 子 agent | **默认继承** | `AGENT_SUBAGENT_THINKING=0` 强制关 |
| 摘要压缩调用 | **否** | 传 `thinking:false`（产出被文本抽取，思考纯浪费） |
| 记忆抽取调用 | **否** | 传 `thinking:false` |

每调用覆盖靠 `CompleteOptions.thinking`（省略=跟随实例 env）。

## 与其它机制

- **长期记忆**：抽取时**剔除**思考块（[src/memory.ts](../src/memory.ts)）——它是模型草稿（含被丢弃的假设 + 一大坨 base64 签名），进记忆是污染 + 烧 token。
- **会话 JSONL**：思考块**原样落盘**，续聊读回保真（工具轮续聊必须）。
- **压缩**：只在「真实用户输入」处切、整轮保留或整轮丢弃、**绝不改写**块内容 → 思考块要么逐字留、要么随旧轮整体摘掉;活跃工具轮的思考总在保留区。搭「整轮不变量」（docs/04）的车。
- **提示词缓存**：两个断点在 system 末 / 最后消息末块（user/tool_result），不落在思考块上;开/关思考改前缀 → 首次重建缓存（低频）。
- **温度**：思考要求 `temperature=1`;本仓库从不设 temperature（默认即 1）→ 天然满足。

## 边界 / TODO

- **模型不支持**：不预判模型清单（易过期），让 API 400 如实冒出 + 此处写明「需支持思考的模型」。
- **adaptive 模式**：较新模型可能支持 `thinking:{type:"adaptive"}`（模型自定思考量）取代固定 budget → TODO（可加 `AGENT_THINKING=adaptive`）。
- **strip 优化**：完成轮的思考块可在回传时删以省 token → TODO（本步每轮全回传，正确优先）。

## 测试（`bun test`，离线）

[tests/thinking.test.ts](../tests/thinking.test.ts)：
- **请求体**：`AGENT_THINKING=1` 带 `thinking` 参数、默认不带、`opts.thinking=false` 覆盖、`budget>=max_tokens` 报错、`budget<1024` 夹到 1024。
- **流解析**：思考块入 content（带签名）、正文走 `onThinkingDelta` 不 yield、答复只含 text。
- **历史保真**：工具调用轮的 assistant 消息原样保留思考块。
- **记忆剔除**：抽取 prompt 不含思考正文/签名、答复正文仍在。

## 下一步

- adaptive 思考模式 / strip 优化（见上 TODO）。
- 其它候选见 [docs/roadmap.md](roadmap.md)（Hooks / Checkpoint / 指令注入…）。
