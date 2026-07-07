# 04 CLI 双通道：/skills [reload] + /<name> 分发 + 用户通道注两条消息

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0014](../../../docs/adr/0014-skills-in-context-on-demand-instruction-packages.md) · 依赖 issue `01`（模块）、`02`（打标）

## 背景

把 skill 接进用户通道：`/skills` 观测、`/skills reload` 刷新菜单、`/<name> args` 手动触发。用户通道无 tool_use，正文只能作 user 消息注入——且要拆成**两条**（原话不打标 + 正文打标），保住用户意图能进记忆。

## 范围

**`src/cli.ts`**：

1. **启动**：`scanSkills()` 一次，把菜单交给 agent（issue 02 注入工具描述），并打印 issue 01 收集的 warnings（含撞名内置命令的 warn，见下）。会话内持有菜单快照（"菜单冷"）。
2. **`/skills`**：列出**全部** skill（含 disabled，标注 `[仅手动]`），标注来源（项目/用户）。
3. **`/skills reload`**：重扫、刷新菜单快照 + 重新注入工具描述、重印 warnings（照抄 `/mcp reload` 形态）。
4. **`/<name>` 分发**（在现有 slash 命令 if 链**之后**兜底）：
   - **内置命令优先**：`/exit /reset /sessions /new /context /memory /todo /agents /mode /mcp /skills` 先匹配；命不中再查 skill 菜单。
   - 命中 skill：`loadSkillBody(meta, args)`（issue 01），**注入两条消息**——① 用户原话（`/<name> args` 原文或等价，作普通 user 消息，**不打标**，进记忆）；② skill 正文（作 user 消息，**打 `{skill:name}` 标记**，issue 02/03 据此剔长期记忆）——然后照常驱动一轮 `agent.send`。
   - 都命不中：提示"未知命令/skill"。
5. **撞名 warn**：加载时若某 skill 名 ∈ 内置命令集合 → warn `⚠ skill "x" 与内置命令同名，其 /x 用户入口被遮蔽（模型仍可调用）`。
6. **首行帮助**：`cli.ts` 那行命令清单加 `/skills`。

## 验收标准

- `/skills` 列全部含 disabled（标注）与来源；`/skills reload` 后新增/删除的 skill 生效、正文改动**无需 reload** 即生效（正文热）。
- `/<name>` 命中 skill → 正文被执行；撞名内置（如 `/memory`）→ 走内置、且启动有 warn。
- 用户通道注入**两条**消息：原话无标记、正文有 `{skill:name}` 标记。跑一次含 skill 的对话后触发长期记忆抽取 → `.memory.md` **不含** skill 正文、**可含**用户意图。
- disabled skill：模型通道不可调（issue 02），用户 `/<name>` **可**调。

## 测试

`tests/skill-cli.test.ts`（或 e2e 风格）：mock skills 目录 + LLM。断言：`/skills` 输出、reload 前后菜单变化、`/<name>` 触发注入两条消息且标记正确、内置优先（`/memory` 不被 skill 劫持）、撞名 warn、正文热改生效。
