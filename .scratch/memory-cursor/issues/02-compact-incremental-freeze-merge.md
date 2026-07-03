# 02 compactHistory 增量冻结 + 合并 + 兜底

Status: ready-for-agent

依赖 [01](01-split-with-frozen-offset.md)。参见 [PRD](../PRD.md) · [ADR-0012](../../../docs/adr/0012-memory-cursor-frozen-summary-blocks.md)

## 背景

把 [`compactHistory`](../../../src/agent.ts#L395) 从「重摘上一版摘要」改为游标 + 冻结块。做完此 issue 即拿到 PRD 主目标（治退化），**不依赖落盘**。

## 范围

`src/agent.ts`：

1. **状态**：`Agent` 加 `frozenCount`（内存历史开头有几条是冻结块）。冻结块仍是带 `[对话摘要]` 前缀的 `user` 消息，多块并存 `[s1, s2, ...]`。
2. **增量冻结（常态）**：超软目标时 `splitForCompaction(history, keepRecentTurns, frozenCount)` → 摘中间段成**一个新块**，`history = [...冻结块, 新块, ...recent]`，`frozenCount++`。
3. **只读上下文（Q3）**：`summarize` 生成新块时，把现有摘要区（`history[0:frozenCount]`）作**只读上下文**拼进 prompt 帮助解引用，但**只输出新块、不改写旧块**。
4. **合并（Q2/Q10）**：追加新块后判定——`frozenCount ≥ 5` **或** 摘要区估算 token ≥ `maxContextTokens × 0.25` → 把**全部**冻结块重摘塌成一块，`frozenCount = 1`。合并是独立一次 LLM 调用。
5. **失败兜底（Q8）**：增量摘要失败 → `truncateHistory(history, maxContextTokens, frozenCount)`，只截 `frozenCount` 之后；冻结块不动。（用户中断仍上抛交 `send` 封口。）
6. 参数可配：合并阈值 M/r 给默认值（5 / 0.25），可选 env 覆盖，风格对齐现有 `keepRecentTurns`。

## 验收标准

- 连续多轮压缩：早期冻结块**逐字不变**（断言块文本跨压缩相等）——退化链断开。
- 第 6 块触发的是**合并**（块数回到 1），不是又一次增量。
- 增量摘要失败 → 冻结块保留、只逐字区被截。
- `frozenCount = 0` 冷启动首次压缩行为与今天一致。

## 测试

`tests/agent.test.ts`：FakeLLM 据 system 关键字返回固定摘要；断言（a）冻结块跨压缩不变、（b）到阈值触发合并、（c）失败兜底不丢冻结块、（d）只读上下文被喂入但输出只含新块。
