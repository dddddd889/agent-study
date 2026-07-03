# 01 splitForCompaction 支持冻结偏移

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0012](../../../docs/adr/0012-memory-cursor-frozen-summary-blocks.md)

## 背景

现 [`splitForCompaction`](../../../src/context.ts#L52) 在**整个** history 上找轮起点，会把开头的冻结块也划进 `old` 重摘——这正是退化 bug 的根源（绕点 7）。要让它把「摘要区」当不可动前缀跳过。

## 范围

`src/context.ts`（纯函数，离线可测，不碰 agent）：

1. 给 `splitForCompaction` 加一个起始偏移参数（如 `frozenCount = 0`）：只在 `messages.slice(frozenCount)` 上找轮边界；返回的 `old` 是「冻结区之后、最近 K 轮之前」的中间段，`recent` 是最近 K 轮。冻结区本身**不进** `old`、也不进 `recent`（由调用方拼回）。
2. 语义保持：偏移后轮数 ≤ K 时 `old` 为空；切点仍对齐真实用户输入。
3. `truncateHistory` 也加同样的偏移，支持「只截 `frozenCount` 之后」（供 issue 02 的兜底用）；`frozenCount` 之前一律保留。

## 验收标准

- `frozenCount = 0` 时行为与今天完全一致（回归）。
- `frozenCount > 0` 时：`old`/`recent` 都不含前 `frozenCount` 条；切点仍落在真实用户输入。
- `truncateHistory(..., frozenCount)` 永不丢弃前 `frozenCount` 条。

## 测试

`tests/context.test.ts` 补：带偏移的切分（冻结区被跳过、轮数≤K 时 old 空、对齐 user 输入）、带偏移的截断（冻结区不动）。
