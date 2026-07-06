# 第 28 步：记忆游标（冻结摘要块 + 增量冻结 + 可丢缓存）

> 第 11 步的摘要压缩每次把「上一版摘要」重新喂回模型（`summary_n = LLM(summary_{n-1} + 新轮)`），是「摘要的摘要」的**退化链**；续聊时还把整条原始流水从零重摘。这一步用**记忆游标**斩断退化：一段旧轮摘成**冻结块**后即定稿、永不再被模型改写。

参见 [ADR-0012](adr/0012-memory-cursor-frozen-summary-blocks.md) 与 [CONTEXT.md](../CONTEXT.md#上下文压缩与记忆游标) 术语区。

## 三段结构

内存历史被游标划成三段：

```
[冻结块 s1 s2 … sn] | [已老化、未摘的轮] | [最近 keepRecentTurns 轮逐字]
        冻结区              中间段(待摘)              逐字区
```

- **游标**由 `Agent.frozenCount`（开头几条是冻结块）划界。`splitForCompaction` 加一个起始偏移，把冻结区当**不可动前缀**跳过 —— 这根治了旧实现「冻结块又被划进 old 重摘」的 bug。

## 三种压缩行为

超软目标 `maxContextTokens` 时（[agent.ts](../src/agent.ts) `compactHistory`）：

1. **增量冻结（常态）**：只把中间段摘成**一个新块**追加到冻结区，游标右移，已冻结块一字不动。生成时把冻结区作**只读上下文**喂入帮助解引用 —— **看≠改写**，退化链不接上。
2. **合并（低频）**：冻结块数 ≥ `mergeBlockThreshold`（默认 5）**或** 冻结区估算 token ≥ `maxContextTokens × mergeZoneRatio`（默认 0.25）时，把**全部**冻结块重摘塌成一块、计数归零。用可控的低频退化，换冻结区不无限膨胀。
3. **截断兜底**：增量摘要/合并失败（网络等）→ `truncateHistory` **只截 `frozenCount` 之后**的逐字轮，冻结块一条不动。一次抖动不该丢掉辛苦攒下的长期摘要。

> 事务性：游标/`frozenCount` 只在整段 `next` 成功构建后才提交，避免合并失败留下半更新的状态。

**摘要输入剔除思考块**：喂给摘要器的 transcript（`serializeForSummary`）把被摘轮里的 `thinking`/`redacted_thinking` 剔掉 —— 草稿 + 一大坨签名，蒸馏进摘要纯烧 token，且**无信息损失**（结论已在 text/tool_use/tool_result 里）。这只改**摘要输入**，`history` 里真实思考块一字不动 —— 主循环回放仍原样保真（见 [ADR-0011](adr/0011-extended-thinking-fidelity.md)、[CONTEXT.md 历史保真](../CONTEXT.md#扩展思考)）。注意与长期记忆同源同理（都剔除思考、但两者实现各自独立）。

## 落盘：可丢的 sidecar 缓存

- **文件**：`<sessionsDir>/<id>/summary.jsonl`（与 `agents/` 同级）。一行一个冻结块 `{seq, cursorAfter, text}`，末行 `cursorAfter` 即当前游标。
- **主流水 `<id>.jsonl` 才是唯一真相**（docs/09 铁律保护的是原始流水）。sidecar 是**派生缓存**：合并时自由重写、空冻结区则删除；写在 `onCompact` 里刷新（截断不动冻结区，不写）。
- **续聊重建**：读 sidecar → 校验（`cursor ≤ 主流水消息数` 且落在轮边界）→ 通过则 `loadHistoryWithFrozen(blocks, cursors, 主流水[cursor:])`，**免全量重摘**；不过/缺失/损坏 → 静默丢缓存，退回第 11 步的读全量、下次重摘。**丢了自愈、绝不因缓存丢历史。**
- **只主 agent 落盘**：sidecar 的价值是「续聊省重摘」，子 agent 不续聊 —— 它保留内存内游标压缩、但不写 sidecar（落盘逻辑只在 CLI 层，子 agent 不经过）。

## 可观测

- `onCompact.strategy` 扩为 `"freeze" | "merge" | "truncate"`，带 `frozenBlocks` / `cursor` / `mergedBlocks`。CLI 打印 `· 上下文压缩(增量冻结：N 轮 → 第K块)…冻结块 ×K · 游标@C`。
- `/context`：`含摘要 ✓ · 冻结块 ×3 · 游标@78`。
- 观察：`AGENT_MAX_CONTEXT_TOKENS=30 bun run start` 连聊几轮即见增量冻结；`AGENT_MERGE_BLOCKS=3` 可更快看到合并。

## 配置

| env / 选项 | 默认 | 说明 |
|---|---|---|
| `keepRecentTurns` | 2 | 逐字保留的最近轮数 |
| `AGENT_MERGE_BLOCKS` / `mergeBlockThreshold` | 5 | 合并的块数阈值 |
| `AGENT_MERGE_ZONE_RATIO` / `mergeZoneRatio` | 0.25 | 合并的冻结区占比阈值 |

## 测试（`bun test`）

- [tests/context.test.ts](../tests/context.test.ts)：带 `frozenCount` 偏移的切分（冻结区被跳过）、截断（冻结区永不丢）。
- [tests/agent.test.ts](../tests/agent.test.ts)：冻结块跨压缩逐字不变（退化链断开）、只读上下文喂入但只输出新块、到阈值触发合并、失败兜底不丢冻结块、`contextStats` 块数/游标、`frozenState`→`loadHistoryWithFrozen` 续聊重建。
- [tests/session.test.ts](../tests/session.test.ts)：sidecar 读写往返、合并式重写行数变少、空冻结区删文件、损坏内容回退 null。

## 留下的 TODO

1. **消息级压缩**（单条超大工具结果/粘贴）—— 仍是 docs/11 的独立 TODO；
2. 精确 token 计数（`count_tokens` API）替代本地估算；
3. 合并的「保新鲜」簿记 / 层次合并（本步明确不做，见 ADR-0012）。
