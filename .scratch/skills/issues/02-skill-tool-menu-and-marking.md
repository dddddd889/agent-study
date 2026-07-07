# 02 skill 工具 + 菜单注入 + 正文打标

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0014](../../../docs/adr/0014-skills-in-context-on-demand-instruction-packages.md) · 依赖 issue `01`

## 背景

把 skill 接进模型通道：一个 `skill` 工具（名字派发）、菜单注入工具描述、正文以 `tool_result` 回上下文并打 `{skill:name}` 标记。

## 范围

**`src/tools.ts`**：新增 `skill` 工具。

- schema：`{ name: string(必), args?: string }`。
- 分类：**非危险**（不进危险工具审批表，对齐 `dispatch_agent`）、**非辅助**（计一步干活，不进辅助工具集）。确认在既有分类清单/集合里正确登记（grep `dispatch_agent` 找到那两处分类定义照着加）。
- 执行：调 issue 01 的定位 + `loadSkillBody(meta, args)`；未知 name → 返回错误结果文本 `未知 skill: <name>，可用: a/b/c`（不抛）；`disable-model-invocation` 的 skill **不允许模型通道调用**（返回同样的"未知/不可用"错误，因它本就不在菜单里）。
- 返回：拼好的正文作为工具结果。

**菜单注入（`src/agent.ts` 或工具描述生成处）**：

- 启动时 `scanSkills()` 得菜单，把**可模型调用**（`disableModelInvocation === false`）的 skill 的 `name — description` 枚举进 `skill` 工具的 description。参照 `dispatch_agent` 动态生成 `agent_type` 枚举 + 描述的现成写法（`roles.ts` 的 `promptRoleNames` + 描述拼装）。
- 空菜单（无任何可模型调用 skill）时，可不暴露 `skill` 工具或暴露空枚举——择一，避免给模型一个没得选的工具。

**正文打标（`src/agent.ts`）**：

- skill 工具的结果消息挂元信息 `{ skill: name }`（消息级 metadata，非内容）。定位历史 `Message` 类型加可选字段（如 `skillMark?: string`）——供 issue 03 的蒸馏识别。
- **绝不影响落盘**：确认 JSONL 写入照常写完整正文（标记可落可不落，但正文必须原样进流水——[[流水]]是唯一真相）。

## 验收标准

- 模型调 `skill("x")` → 拿到 x 的正文（含 Base directory 行）；带 args → 正文尾部有 ARGUMENTS。
- 未知 / disabled 的 name → 返回错误结果、列出可用项、不抛。
- `skill` 工具**不触发**危险工具审批；**消耗一步**干活（在 workSteps 计数里体现）。
- 工具描述里的菜单 = 全部可模型调用 skill 的 name+desc；disabled 的不在其中。
- 结果消息带 `{skill:name}` 标记；JSONL 里正文完整原样。

## 测试

`tests/skill-tool.test.ts`：mock skills 目录，断言：正文注入内容、未知/disabled 报错文案、workSteps +1、非危险（不进审批）、菜单枚举正确、结果消息带标记、JSONL 正文完整。
