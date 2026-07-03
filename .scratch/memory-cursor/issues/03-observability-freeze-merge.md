# 03 可观测：三态 + 块数/游标上屏

Status: ready-for-agent

依赖 [02](02-compact-incremental-freeze-merge.md)。参见 [PRD](../PRD.md) · [ADR-0012](../../../docs/adr/0012-memory-cursor-frozen-summary-blocks.md)

## 背景

docs/11 把「上下文可观测」当卖点。新机制多了 `freeze`/`merge` 两种行为，要在 `onCompact` 和 `/context` 里分清楚（Q9）。

## 范围

1. **`onCompact.strategy`**（[agent.ts:57](../../../src/agent.ts#L57)）扩为 `"freeze" | "merge" | "truncate"`。`droppedTurns` 语义：freeze = 折进新块的轮数；merge = 参与合并的块数（或复用字段并另加 `mergedBlocks`，实现自定，测试能断言即可）。
2. **CLI 打印**（`src/cli.ts` 的 `onCompact` 处理）：
   - `· 上下文压缩(增量冻结)：N 轮 → 第K块（~X→~Y token）`
   - `· 上下文压缩(合并)：M块→1块（~X→~Y token）`
   - 截断兜底沿用现文案。
3. **`contextStats()`**（[agent.ts:361](../../../src/agent.ts#L361)）加 `frozenBlocks`（块数）与 `cursor`（游标位置）；`/context` 显示如 `含摘要 ✓ · 冻结块 ×3 · 游标@78`。

## 验收标准

- 三种行为各自触发对应 `strategy` 值（测试可断言）。
- `/context` 正确显示块数与游标；无冻结块时不显示这两项（或显示 ×0 / @0，择一并测）。

## 测试

`tests/agent.test.ts`：断言 freeze/merge/truncate 三态分别被 `onCompact` 上报；`contextStats()` 的块数/游标随压缩更新。
