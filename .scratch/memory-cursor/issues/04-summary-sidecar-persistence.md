# 04 sidecar 落盘与续聊重建

Status: ready-for-agent

依赖 [02](02-compact-incremental-freeze-merge.md)（03 可并行）。参见 [PRD](../PRD.md) · [ADR-0012](../../../docs/adr/0012-memory-cursor-frozen-summary-blocks.md)

## 背景

第二步：让冻结摘要熬过续聊，不再全量重摘。旁挂**可丢的派生缓存**，主流水仍是唯一真相（Q4/Q5）。

## 范围

`src/session.ts` + `src/agent.ts` 接线：

1. **文件**：`<sessionsDir>/<id>/summary.jsonl`（与 `agents/` 同级，复用 session 目录）。一行一个冻结块：`{"seq":n,"cursorAfter":C,"text":"..."}`，末行 `cursorAfter` = 当前游标。
2. **写**（只主 agent）：
   - 增量冻结 append 一行（append-only 友好）。
   - 合并 → **重写**整个文件为更少的行（派生缓存，允许重写）。
3. **游标语义**：`cursorAfter` = 已折进冻结块的**原始主流水消息数**（`<id>.jsonl` 的行数下标）。
4. **续聊重建**（`loadSession` 路径）：
   - 读 sidecar 拿冻结块 + 游标；
   - **校验**：sidecar 能 parse、`cursorAfter ≤ 主流水消息数`、且主流水 `[cursorAfter]` 是合法轮边界（`isUserInput`）；
   - 过 → 工作历史 = `[冻结块消息...] + 主流水[cursorAfter:]`，`frozenCount = 块数`；
   - **不过 / 缺失 / 损坏** → **静默丢弃 sidecar**，回退到今天的「读全量、下次压缩重摘」（`frozenCount = 0`）。
5. **子 agent 不写**（Q6）：落盘逻辑仅在主 agent 生效。

## 验收标准

- 正常续聊：读回冻结块、`frozenCount` 正确、游标之后逐字接上，**不触发重摘**。
- sidecar 删除 / 游标越界 / 单行损坏 → 自动退回全量重摘，**不报错、不丢历史**。
- 合并后 sidecar 行数正确变少、`cursorAfter` 不变。
- 主流水 `<id>.jsonl` 全程一字节不改（docs/09 不变量）。

## 测试

`tests/session.test.ts` + `tests/agent.test.ts`：sidecar 读写往返；续聊重建拿到正确 `frozenCount`/游标；缓存损坏/越界回退全量；合并重写文件；子 agent 不产出 sidecar。
