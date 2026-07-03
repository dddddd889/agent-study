# PRD：记忆游标（冻结摘要块 + 增量冻结 + 可丢 sidecar）

参见 [ADR-0012](../../docs/adr/0012-memory-cursor-frozen-summary-blocks.md) 与 [CONTEXT.md](../../CONTEXT.md#上下文压缩与记忆游标) 术语区。本 PRD 只讲「要做什么 / 验收标准 / 拆分」，取舍理由在 ADR。

## 背景

现摘要压缩每次把「上一版摘要」重新喂回模型（[agent.ts:399](../../src/agent.ts#L399)），形成「摘要的摘要」的退化链；续聊时还把整条原始流水从零重摘（[docs/11](../../docs/11-summarization-compaction.md)）。

## 目标

1. **主目标**：斩断退化——一段旧轮摘成**冻结块**后即定稿、永不再被模型重写。
2. **次目标**：续聊不再全量重摘（旁挂可丢的 sidecar 缓存）。

## 核心模型

内存历史三段：`[冻结块 s1..sn] | [已老化未摘的轮] | [最近 K 轮逐字]`。
- **记忆游标**：标记「此位置前的原始轮已冻结」，由 `Agent.frozenCount` 划界。
- **增量冻结**（常态）：只摘中间段成一个新块追加，游标右移，已冻结块不动；生成时把摘要区作**只读上下文**喂入。
- **合并**（低频）：冻结块数 ≥ 5 **或** 摘要区占比 ≥ 25%（先到）→ 全部冻结块重摘塌成一块、计数归零。
- **落盘**：`<id>/summary.jsonl`（一行一块 + 末行 `cursorAfter`）作派生缓存；主流水 `<id>.jsonl` 唯一真相；校验不过就丢缓存、退回全量重摘。只主 agent 落盘。
- **失败兜底**：增量摘要失败 → 只截 `frozenCount` 之后的逐字轮。
- **观测**：`onCompact.strategy` = `freeze | merge | truncate`；`/context` 显示块数 + 游标。

## 默认参数

| 名称 | 默认 | 说明 |
|---|---|---|
| `keepRecentTurns` | 2 | 沿用现值 |
| 合并块数阈值 M | 5 | Q2 |
| 合并占比阈值 r | 0.25 | 相对 `maxContextTokens`，Q2 |

## 落地顺序（两步走）

- **第一步（内存内游标，治退化）**：issue 01 → 02 → 03。做完即拿到主目标，不依赖落盘。
- **第二步（落盘，治续聊重摘）**：issue 04。纯增量叠加在第一步之上、不返工。

## Issues

- [01 splitForCompaction 支持冻结偏移](issues/01-split-with-frozen-offset.md)
- [02 compactHistory 增量冻结 + 合并 + 兜底](issues/02-compact-incremental-freeze-merge.md)
- [03 可观测：三态 + 块数/游标上屏](issues/03-observability-freeze-merge.md)
- [04 sidecar 落盘与续聊重建](issues/04-summary-sidecar-persistence.md)

## 非目标

- 消息级压缩（单条超大工具结果/粘贴）——仍是 [docs/11](../../docs/11-summarization-compaction.md) 的独立 TODO。
- 精确 token 计数（`count_tokens` API）——沿用本地估算。
- 子 agent 落盘 / `agents/` 布局重构——明确不做（Q6）。
- 合并的「保新鲜」簿记 / 层次合并——明确不做（Q10）。
