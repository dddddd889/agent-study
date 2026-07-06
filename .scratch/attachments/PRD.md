# PRD：用户消息附件（图片 / PDF）

参见 [ADR-0013](../../docs/adr/0013-attachments-content-addressed-blob-store.md) 与 [CONTEXT.md](../../CONTEXT.md#附件多模态输入) 术语区。本 PRD 只讲「要做什么 / 验收标准 / 拆分」，取舍理由在 ADR。

## 背景

现在用户输入只能是一行文本（[cli.ts](../../src/cli.ts) 读行 → `agent.send(text)`），`send` 也只收 `string`（[agent.ts:220](../../src/agent.ts#L220)）。模型看不到用户想给的图片 / PDF。而底层管道其实已就绪：`Message.content` 已是 `string | ContentBlock[]`（[types.ts:54](../../src/types.ts#L54)），`llm.ts` 基本原样透传 content 给 Anthropic API。差的是「用户 → 模型」这条附件通道。

## 目标

1. **主目标**：用户能在 REPL 里用 `@路径` 给消息挂**本地图片 / PDF**，喂给模型。
2. **约束**：流水精简（不把 base64 塞进 JSONL）、`llm.ts` 保持纯透传、`agent.ts` 不碰文件系统——守住既有设计线。

## 核心模型

```
用户输入 "看看 @a.png 的趋势"
  → CLI 解析 @a.png（存在且为图片/PDF）
  → attachments.ingest：读字节 → 魔数判类型 → 算 sha256 → 落 blob 仓 → 算 token 估值
  → 拼出 [text块, ref块]  →  agent.send(ContentBlock[])
  → 历史 / JSONL 里只存【轻量 ref 块】

调模型时：
  agent 遍历消息，遇 ref 块 → 注入的 blobResolver 读 blob → base64 →
  拼成 API 的 image/document 块（临时 wire 副本，用完即弃）→ llm.stream
```

- **内容块**：照抄 API 的两种块——图片 `image`、PDF `document`，共享 `source` 子结构（base64/url/file，本步只用 base64）。
- **ref 块**（历史 / 落盘形态）：`{type:"image"|"document", ref:sha256, name, mediaType, tokens}`。永不内联 base64。
- **内容寻址 blob 仓**：`.sessions/<id>/blobs/<sha256>` 存字节原文；每会话独占、随删会话一起没、不单独 GC。同图去重（同 sha256 只存一份）。
- **重放（rehydrate）**：喂 API 前经注入 `blobResolver` 把 ref 换 base64，**用完即弃、不缓存**；`this.history` 与 `llm.ts` 全程不变。
- **压缩**：蒸馏成摘要时附件块替换成**文字标记** `[图片 a.png]`（与 thinking 剔除同款，[compactor.ts:63](../../src/compactor.ts#L63)）；冻结后原图不可见（已知局限）。图片**不做急切剔除**——留在历史随压缩窗口统一淘汰。
- **删除**：不加命令。批量删 = 删会话（blobs 随之没）；抹某张图 = 删其 blob 文件。核心是**重放对缺失 blob 优雅降级**——`blobResolver` 读不到返回 `null`，重放换成 text 块 `[图片 x.png（已删除）]`，不报错。这条本就是 blob 损坏/丢失的健壮性所需。
- **token 估算**：ingest 时按 `ceil(宽×高/750)`（图，封顶）/ `页数×常量`（PDF）算一次、存进 ref 块的 `tokens`；`estimateTokens`（[context.ts](../../src/context.ts)）直接读，不碰 blob。

## 默认参数

| 名称 | 默认 | 说明 |
|---|---|---|
| 支持类型 | 图片(png/jpg/gif/webp) + PDF | 其余明确拒绝 |
| 来源 | 仅本地文件 → base64 | URL/Files API 留 TODO |
| 单文件上限 | 图 ~5MB / PDF ~32MB | 贴合 API 32MB 请求体上限 |
| 单条消息附件数 | ≤ 10 | 与「最近 K 轮」共同框住 base64 峰值 |
| 图片 token 上限 | ~1600（旧）/ ~4784（高清） | w×h/750 封顶 |

## Issues

- [01 attachments 模块 + ref 块 + blob 仓](issues/01-attachments-module-blob-store.md)
- [02 接入主链路：send 收块 / agent 重放 / CLI @路径 ingest](issues/02-wire-into-agent-cli.md)
- [03 压缩与 token 估算适配 + /context 计数](issues/03-compaction-and-token-estimation.md)

## 非目标（留 TODO）

- **B · 工具结果返图**：`ToolResultBlock.content` 从 `string` 放宽成块数组——独立且更大的一步。
- **Office 文档转换**：Excel/Word/PPT 需先转 CSV/PDF（API 不认），需解析库。
- **URL / Files API 来源**：`source.type` 多两种，改动小但另做。
- **冻结前 caption**：给图生成描述再冻结，保住语义；需额外视觉 LLM 调用。
- **子 agent 附件**：子 agent 不续聊、走结构化派活，入口是另一码事。
- **急切剔除附件**（对标 `clear_tool_uses`）：贴完即从历史剔除，省 token 但失去回看能力。
- **显式删除命令**（`/attach rm <name>`）与 **blob GC**（回收游标之后不再被引用的 blob）：有了「缺失优雅降级」路径，将来加它们只是 `rm` 文件 + 扫引用，无需返工。
