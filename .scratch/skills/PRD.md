# PRD：Skill 能力（可插拔的按需指令包）

参见 [ADR-0014](../../docs/adr/0014-skills-in-context-on-demand-instruction-packages.md) · 术语见 [CONTEXT.md「Skill 能力」](../../CONTEXT.md)

## 目标

给内核加 **skill**：一个按需加载、注入**当前 agent 上下文**、模型可自主选用（也可用户 `/<name>` 手动触发）的指令/流程包，存放于 `.claude/skills/<name>/SKILL.md`。对标 Claude Code 的 skill。

## 非目标（本步不做）

- 远程 / 插件市场分发（只做本地双扫）。
- 捆绑资源的专门加载器（正文引导模型 `read_file` 自取即可）。
- frontmatter 的 `allowed-tools` / `model` / 预算覆盖（那是隔离实例的特征，skill 不隔离）。

## 用户故事

1. 我在 `.claude/skills/code-review/SKILL.md` 放一份「代码审查流程」，模型在合适时机自己调 `skill("code-review")`，按流程审查——无需我手动介入。
2. 我敲 `/code-review src/agent.ts`，同一 skill 被手动触发，`ARGUMENTS` 带上路径。
3. 我把 `disable-model-invocation: true` 的私人 skill 放 `~/.claude/skills/`，跨项目复用，且模型不会自动调它、只在我手动 `/<name>` 时生效。
4. skill 流程指令**不会**污染我的长期记忆 `.memory.md`。

## 设计要点（详见 ADR-0014）

- **来源**：项目级 `.claude/skills/` + 用户级 `~/.claude/skills/`，同名项目覆盖用户。
- **结构**：目录式 `<name>/SKILL.md`；`name` 以目录名为准；frontmatter = `description`(必填) + `disable-model-invocation`(可选)。
- **双通道**：模型 `skill(name, args?)` 工具（非危险、计一步干活）+ 用户 `/<name> args`（内置命令优先，撞名 warn）。共用「定位 → 读正文 → 拼装(顶 `Base directory:` / 尾 `ARGUMENTS:`) → 打 `{skill:name}` 标记」；载体随通道（`tool_result` / user 消息两条）。
- **渐进披露**：菜单(name+desc)注入 `skill` 工具描述、启动扫一次(冷)；正文调用时现读(热)。`/skills` + `/skills reload`。
- **三层蒸馏**：流水原样、短期记忆正常摘要、长期记忆剔除。`serializeForDistill` 加 `dropSkill` 参数（记忆 true / 压缩 false，拆别名）。
- **错误**：加载软失败（跳过 + warn 不崩启动）；调用回错误结果不抛。

## Issues

- `01` skills 模块：扫描 / frontmatter / 定位 / 读正文 + 拼装（`src/skills.ts`）
- `02` `skill` 工具 + 菜单注入 + 正文打标（`tools.ts` / `agent.ts`）
- `03` 三层蒸馏：`serializeForDistill` 加 `dropSkill`（`context.ts` / `memory.ts` / `compactor.ts`）
- `04` CLI 双通道：`/skills [reload]` + `/<name>` 分发 + 用户通道注两条消息（`cli.ts`）

依赖：01 → (02, 04)；02（打标）→ 03。
