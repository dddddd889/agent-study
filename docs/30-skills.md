# 第 30 步：Skills（可插拔的按需指令包 / 渐进披露 / 双通道）

> 一个 **skill** 是「按需加载、注入**当前 agent 上下文**、模型可自主选用（也可用户手动）」的指令/流程包。放个 `SKILL.md` 就多一个专家流程，模型在合适时机把它摊开、照着做。它区别于三个近邻——记忆是**常驻**事实、角色是**隔离**子 agent 的人格+裁工具、slash 命令是**纯用户触发**的 prompt。

参见 [ADR-0014](adr/0014-skills-in-context-on-demand-instruction-packages.md) 与 [CONTEXT.md](../CONTEXT.md#skill-能力) 术语区。

## 一个 skill 长什么样

```
.claude/skills/<name>/SKILL.md      # 项目级(跟仓库走)
~/.claude/skills/<name>/SKILL.md    # 用户级(跨项目)，同名时项目覆盖用户
```

> 基础目录名 `.claude` 由 `AGENT_CONFIG_DIR` 控制（默认 `.claude`）：`AGENT_CONFIG_DIR=.agent` 就从 `.agent/skills` 加载——用来避开与**真 Claude Code** 的 `.claude/skills` 互相扫描/污染。测试另有完整路径覆盖 `AGENT_SKILLS_DIR` / `AGENT_SKILLS_USER_DIR`。

```markdown
---
description: 一句话，模型据此决定要不要用它（必填）
disable-model-invocation: true      # 可选：仅用户 /<name> 可调，不进模型菜单
---
这里是注入到对话的流程正文。可以引导模型 read_file 同目录的 reference.md 等资源。
```

`name` **以目录名为准**（单一真相，frontmatter 不写）。目录式而非扁平文件，为将来捆绑脚本/模板/参考文档留门。

## 渐进披露：正文热、菜单冷

- **启动**：`scanSkills()`（[src/skills.ts](../src/skills.ts)）扫两处目录，**只解析 frontmatter** 拼出「name + description」菜单。菜单是那句廉价的一行，注入 `skill` 工具的 description（吃[提示词缓存](22-prompt-caching.md)前缀）。
- **调用时**：`loadSkillBody()` 才**现读** `SKILL.md` 正文、剥 frontmatter，顶部加 `Base directory for this skill: <abs>`（给相对引用锚点）、尾部加 `ARGUMENTS: <args>`。
- 于是：改**正文**立即生效（热）；只有增删 skill 或改 name/description（即菜单）才需 `/skills reload`（冷）。

## 两条触发通道

| 通道 | 怎么触发 | 载体 |
|---|---|---|
| **模型** | 模型调 `skill(name, args?)` 工具（[src/skills.ts](../src/skills.ts) `createSkillTool`，单一工具+名字派发，菜单进描述） | 正文回作 `tool_result` |
| **用户** | 用户敲 `/<name> args`（[src/cli.ts](../src/cli.ts)，**内置命令优先**，撞名加载 warn） | 无 tool_use → 注入**两条** user 消息 |

`skill` 工具对齐 [dispatch_agent](15-subagent.md)：**非危险**（只读 md + 注入文本，真副作用在正文引导模型后续调的工具上）、**计一步干活**。子 agent **保留** skill（不起新实例，不犯禁嵌套）。

两通道共用「定位→读正文→拼装→打标」，只有第 6 步载体随通道分。用户通道注入两条是因为 Anthropic API 要求 `tool_result` 必配对 `tool_use`——用户通道没有 tool_use，只能作 user 消息；拆成**原话**（不打标，进记忆）+ **正文**（打标，剔记忆），保住用户意图不丢。连续两条 user 消息 API 允许并合并为一轮。

## skill 标记与三层蒸馏

skill 正文是**流程指令**，不是对话内容。给它挂标记 `{skill:name}`（模型通道在 `tool_result` **块级**、用户通道在**消息级**），三层命运不同：

| 层 | skill 正文 |
|---|---|
| 会话流水（JSONL） | **原样保留**，永远（标记不碰落盘，[流水](09-persistence.md)是唯一真相） |
| 短期记忆 / [压缩](28-memory-cursor.md) | 活跃期完整；老化随窗口**正常摘要** |
| 长期记忆（`.memory.md`） | **剔除**（不沉淀流程指令） |

落地：[src/context.ts](../src/context.ts) `serializeForDistill(msgs, { dropSkill })` —— [记忆抽取](12-long-term-memory.md)传 `true`（按标记剔），[摘要压缩](28-memory-cursor.md)传 `false`（保留）。这刻意拆开了两者原本共用的别名（[ADR-0013](adr/0013-attachments-content-addressed-blob-store.md)）：两者对 skill 的诉求本就不同。标记**只盖正文不盖意图**——同轮的用户原话 / 模型 `tool_use` 不打标，照常进记忆。块级标记还保证：skill 与别的工具**同轮批量**收进一条消息时，只剔 skill 那一块。

> 线安全：块级 `skillMark` 绝不能上线（多余字段可能 400）。按「llm.ts 纯透传」的不变量，在 agent 的 `rehydrate`（喂 API 前整备边界）剥掉；消息级标记则被 llm 的 `{role,content}` 映射天然丢弃。

## 加载软失败

坏 skill 只被跳过 + 收一条 warning，**绝不拖垮启动**（对齐 `/mcp reload`、工具错误回结果的一贯风格）：无 `SKILL.md` / 缺 `description` / frontmatter 坏 / 目录名非法 token → 跳过。调用未知 skill → 回错误结果让模型改口，不抛。

## 命令

- `/skills`：列**全部**（含 `[仅手动]` 的 disabled）+ 来源（项目/用户）。
- `/skills reload`：重扫、刷新菜单、重挂工具（运行时 `setTools`）、重印告警。
