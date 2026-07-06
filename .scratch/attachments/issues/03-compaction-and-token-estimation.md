# 03 压缩与 token 估算适配 + /context 计数

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0013](../../../docs/adr/0013-attachments-content-addressed-blob-store.md) · 依赖 [issue 01](01-attachments-module-blob-store.md)

## 背景

附件进历史后，两处已有逻辑会「看不见」它、产生 bug：token 估算漏算（触发器不准、`/context` 撒谎），蒸馏时若不处理会把 base64 喂给摘要器。两处都有现成先例可照抄。

## 范围

**`src/context.ts` — token 估算**：`messageText` 现在对非文本块返回 `""`（[context.ts:37](../../../src/context.ts#L37)），ref 块贡献 0 token。给 `estimateTokens` 加分支：遇到 ref 块（`type` 为 image/document 且带 `ref`）直接累加 `b.tokens`（issue 01 在 ingest 时已算好、存进块里，此处不碰 blob、不重算）。

**`src/compactor.ts` — 蒸馏剔除附件**：`serializeForSummary` 已在 `filter` 掉 thinking/redacted_thinking（[compactor.ts:68](../../../src/compactor.ts#L68)）。给同一处加：ref 块**替换成文字标记** `[图片 <name>]` / `[PDF <name>]`（而非 filter 掉——要让摘要知道「这儿曾有张图」）。绝不把 base64 喂给摘要那次 LLM 调用。

**`src/cli.ts` — `/context` 计数**：在上下文那行加「附件 ×N」（N = 当前历史里 ref 块数）。附件 token 已计入 `~N token`，这里只多报数量。

## 验收标准

- 含 3 张图的历史：`estimateTokens` 比纯文本版高出约 3×图 token；`/context` 显示「附件 ×3」。
- 触发压缩时，喂给摘要器的序列化文本里附件是 `[图片 x.png]` 标记，无 base64。
- 被冻结后的旧轮：摘要文本保留标记；最近 K 轮的 ref 块不受影响（仍能重放看原图）。
- 不含附件的会话：三处行为与今天完全一致（回归）。

## 测试

- `tests/context.test.ts`：带 ref 块的消息 `estimateTokens` 计入 `tokens` 字段。
- `tests/compactor.test.ts`：`serializeForSummary` 把 ref 块转成文字标记、不泄漏 base64。
