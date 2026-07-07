# 03 三层蒸馏：serializeForDistill 加 dropSkill

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0014](../../../docs/adr/0014-skills-in-context-on-demand-instruction-packages.md) · 依赖 issue `02`（需先有 `{skill:name}` 标记）

## 背景

skill 正文的三层命运（见 ADR-0014「三层蒸馏处置」）：**流水**原样、**短期记忆/压缩**正常摘要、**长期记忆**剔除。落地是给共享的蒸馏函数加一个开关，并拆开 [ADR-0013](../../../docs/adr/0013-attachments-content-addressed-blob-store.md) 起 compactor 与 memory 共用的别名。

## 范围

**`src/context.ts`**：给 `serializeForDistill(history, opts?)` 加 `opts.dropSkill?: boolean`（默认 `false`）。

- `dropSkill === true`：遍历时**跳过**带 `{skill:name}` 标记的消息（issue 02 的 `skillMark`）——即长期记忆看不到 skill 正文。
- `dropSkill === false`：**保留**该消息、当普通内容序列化——即压缩照常摘要。
- 现有行为（剔思考块 / 附件转文字标记）**完全不变**，只在其上叠加这一条。

**`src/memory.ts`**：`extractMemory` 里的 `serializeForDistill(history)` 改为 `serializeForDistill(history, { dropSkill: true })`。

**`src/compactor.ts`**：**拆别名**。当前 `const serializeForSummary = serializeForDistill;` 改为显式调用 `serializeForDistill(msgs, { dropSkill: false })`（或 `serializeForSummary = (m) => serializeForDistill(m, { dropSkill: false })`），保留 skill 正文照摘。更新该行注释：说明这里刻意与记忆分叉（记忆剔 skill、压缩留 skill），不再是"收口一处"。

## 验收标准

- 一段含 skill 标记消息的历史：`serializeForDistill(h, {dropSkill:true})` 的输出**不含**该正文；`{dropSkill:false}`（及默认）的输出**含**该正文。
- 长期记忆抽取喂给 LLM 的 transcript 不含 skill 正文；摘要压缩喂给 LLM 的 transcript 含 skill 正文。
- 标记**只盖正文**：同一轮里用户原话 / 模型 tool_use（无 skill 标记）在 `dropSkill:true` 下**仍保留**（意图能进记忆）。
- 思考块剔除 / 附件标记等既有蒸馏行为回归不变。

## 测试

`tests/skill-distill.test.ts`（或并入既有 context/memory 测试）：构造带 `{skill}` 标记消息 + 普通消息 + 用户原话的历史，断言两种 `dropSkill` 下的输出差异；断言用户原话在 `dropSkill:true` 下不被误删。回归既有 `serializeForDistill` 测试（思考/附件）。
