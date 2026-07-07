---
Status: accepted
---

# Skill：在当前上下文按需展开的指令包（渐进披露 + 双通道 + 三层蒸馏）

## 决策

加**可插拔的 skill 能力**：一个 skill 是「按需加载、注入**当前 agent 上下文**、模型可自主选用（也可用户手动触发）」的指令/流程包，以 `.claude/skills/<name>/SKILL.md` 存放。它区别于三个近邻——记忆（常驻事实）、角色（隔离子 agent 的人格 + 裁工具）、slash 命令（纯用户触发的 prompt）。

- **定位（Q1）**：三条本质性质——① **渐进披露**：启动只加载 `description` 一句话菜单，正文调用时才读；② **当前上下文执行、不隔离**（区别于[[子 agent]]的「隔离 + 只回结论」）；③ **模型可自主选用**（区别于纯用户触发的 slash 命令）。一句话：记忆=常驻事实、角色=隔离实例的人格、slash 命令=用户触发 prompt、**skill=模型按需摊开的专家流程**。
- **来源（Q2）**：本地双扫——项目级 `.claude/skills/` + 用户级 `~/.claude/skills/`，**同名项目覆盖用户**。远程/插件市场明确留 future（分发是正交的工程问题，不属这一步的教学核心）。
- **磁盘结构（Q3）**：**目录式** `.claude/skills/<name>/SKILL.md`，不用扁平 `<name>.md`——为将来捆绑资源（脚本/模板/参考文档）留门，且与本机既有 skill 约定一致。
- **frontmatter（Q5）**：`description`（**必填**，菜单文案 + 模型选用依据）+ `disable-model-invocation`（可选，默认 `false`，`true` = 仅用户 `/<name>` 可调、不进模型菜单）。`name` **以目录名为准**（单一真相，少一个漂移点），frontmatter 不写。**不做** `allowed-tools` 与 `model`/预算——那是「隔离实例」才有的特征（见「为什么这样」）。
- **调用（Q4/Q6/Q7）**：**单一 `skill` 工具 + 名字派发**（不给每个 skill 造伪工具、不污染工具空间、不破坏缓存前缀），菜单（name+desc）注入 `skill` 工具的 description。用户端并行支持 `/<name>`。执行机械步骤：定位目录 → 读 `SKILL.md` → 剥 frontmatter → 正文顶部加 `Base directory: <abs>` 行、尾部加 `ARGUMENTS: <args>` 行 → 给正文消息打 `{skill:name}` 标记。
- **载体随通道（Q7）**：模型通道正文回作 `tool_result`（天然是那次工具调用的结果）；用户通道**没有 tool_use**（API 硬约束：`tool_result` 必须配对同 id 的 `tool_use`），故注入**两条**消息——用户原话（**不打标**，进记忆）+ skill 正文（**打标**，剔记忆）。「内容同源、载体随通道」。
- **工具分类（Q9）**：`skill` 对齐 [[dispatch_agent]]——**非危险**（本身只读一个 md 并注入文本，真副作用发生在正文引导模型后续调的那些工具上，它们各自该确认时自会确认）、**计一步干活**（是实质推进动作，非[[辅助工具]]）。
- **子 agent（Q10）**：子 agent **保留** `skill`。禁嵌套针对的是「起新隔离实例」（`dispatch_agent`/`critic`）；skill 不起新实例、只往当前上下文注指令，不犯此忌。正文若引导调 `dispatch_agent` 而子 agent 无此工具 → 自然失败，不破坏隔离，无需特判。
- **加载时机（Q11）**：**正文热、菜单冷**——菜单启动扫一次（冷，改需 reload）、正文调用时现读（热，改即生效）。`/skills` 列全部（含 disabled，标注）、`/skills reload` 重扫。
- **冲突（Q12）**：`/<name>` 直呼、**内置命令优先**（`/exit`…`/mcp`…保留字不可覆盖）、撞名**加载 warn**（模型通道不经 slash 解析，仍可用）。不加 `/skill <name>` 前缀命名空间（手感优先，冲突罕见且已 warn）。
- **错误处理（Q13）**：**加载软失败**（无 `SKILL.md` / 缺 `description` / YAML 坏 / 目录名非法 token → 跳过 + warn，绝不崩启动）；**调用给信息**（未知 skill 回错误 `tool_result` 列可用项让模型改口，不抛异常）。风格对齐 `/mcp reload` 软失败、工具错误回结果。
- **资源范围（Q14）**：这一步**不做专门资源机制**。红利：skill 在当前上下文、用当前工具执行，正文引导「读本目录 `reference.md`」时模型直接 `read_file` 即可，无需造资源加载器。注入 `Base directory:` 行给相对引用锚点。目录式结构已为将来「资源清单/预加载」留位、不返工。

## 三层蒸馏处置（Q8）

skill 正文是**指令文本、非对话内容**，在三层里命运不同：

| 层 | 是什么 | skill 正文 |
|---|---|---|
| **会话流水（JSONL）** | append-only、[[流水\|唯一真相]] | **原样保留，永远**（标记不碰落盘） |
| **短期记忆（工作上下文）** | 每轮发给 LLM 的 history | **活跃期完整**；老化触发[[摘要压缩]]时**当普通内容正常摘要** |
| **长期记忆（`.memory.md`）** | 跨会话蒸馏的事实/偏好/决定 | **剔除**（不沉淀流程指令） |

落地：给 `context.serializeForDistill` 加 `dropSkill` 参数——**记忆抽取传 `true`**（按 `{skill:name}` 标记剔）、**摘要压缩传 `false`**（保留照摘）。这拆开了 [ADR-0013](0013-attachments-content-addressed-blob-store.md) 起两者共用的 `serializeForSummary = serializeForDistill` 别名——是一处**刻意的、受控的分叉**：记忆诉求是「别沉淀流程」，压缩诉求是「照常压缩」，两者本就不同。标记**只盖正文、不盖意图**：用户原话与模型 `tool_use`（含 name+args）不打标，「用了 skill X 干 Y」这层意图照常能进记忆。

## 为什么这样

- **skill vs 角色 vs 子 agent——用「隔离与否」一刀切开**：凡「隔离实例」才有的特征（裁工具、独立预算、换模型），skill 一律不要。因为 skill **不隔离**、就在主上下文里，这些概念对它根本不成立。要裁工具/独立预算 → 用[[角色]]/子 agent；要在当前上下文摊流程 → 用 skill。这条边界同时解释了为什么 frontmatter 不做 `allowed-tools`/`model`，也解释了为什么子 agent 能保留 skill（不违禁嵌套）。呼应 CONTEXT.md 一贯的反同义词漂移。
- **单一 `skill` 工具而非每 skill 一个伪工具**：伪工具方案随 skill 增多**污染工具空间**、挤占[[提示词缓存]]前缀、干扰模型对真工具的选择；纯 system 菜单 + 自然语言拦截又**解析脆弱**、脱离既有工具循环基建。单工具 + 名字派发只占一个工具槽，菜单随工具描述一起吃缓存，且直接复用现成的工具调用闭环。
- **渐进披露是 skill 区别于记忆的本质**：记忆是**常驻**注入、skill 是**按需**。启动只吃一句 `description`（廉价菜单），正文只有被选中才进上下文——这正是「正文热、菜单冷」策略的由来：菜单进缓存前缀不该每轮重扫，正文按需现读天然最新。
- **载体随通道是被 API 逼出来的，不是偏好**：Anthropic API 要求 `tool_result` 必配对同 id 的 `tool_use`。用户通道压根没有 tool_use，就无法伪造 tool_result，只能作 user 消息注入。强行统一要么发非法块、要么伪造模型没发过的 tool_use。故接受「内容同源、载体随通道」。
- **标记只盖正文、不盖意图**：用户敲 `/<name> 我想做 X` 里的「我想做 X」是真实用户意图，**该能进记忆**。若把注入的整条（正文 + ARGUMENTS）都打标剔掉，意图就丢了。故用户通道拆成两条消息（原话 + 正文），与模型通道（`tool_use` 留 + `tool_result` 剔）对称。
- **三层蒸馏选「正常摘要」而非「打桩」（Q8 甲）**：曾考虑老化时把正文塌成 `[已调用 skill: x]` 一句桩以免「摘一段说明书很怪」。最终选**正常摘要**——特殊处理只集中在**长期记忆**这一处（唯一硬需求：别沉淀流程），短期记忆/压缩当普通内容对待，把 skill 对既有蒸馏管线的侵入压到最小。skill 正文老化本就罕见（通常用完即随对话推进），不值得为它在压缩侧再加一套桩逻辑。

## 边界与考量

- **远程/插件分发留 future**：本地能加载 + 执行是地基；远程只是在其上加「拉取到本地」一层，地基不变。下载/缓存/信任/版本是独立工程问题，不塞进这一步。
- **捆绑资源不做加载器、但可用**：正文引导模型 `read_file`/`run_shell` 去碰同目录文件即可（skill 在当前上下文有全套工具）。「资源清单/预加载」留 TODO，目录式结构不返工。
- **`disable-model-invocation` 撑起双通道的可见性差异**：`true` 的 skill 从模型菜单隐身、仅 `/<name>` 可达（本机 `grill-with-docs` 即此类）。`/skills` 仍列出它（标注 disabled），用户能看见能手动调。
- **嵌套 skill 允许**：skill 正文里再调 `skill` 只是往同一上下文注更多指令、不起新实例，受[[干活步数]]预算兜底，无需特判（理由同「子 agent 保留 skill」）。
- **撞名内置命令只遮用户入口**：`skill` 名撞内置（如 `memory`）时，`/<name>` 被内置遮蔽但**模型通道仍可调**（不经 slash 解析）。加载 warn 让作者早知道，不静默。

## 落地

见 PRD [.scratch/skills/PRD.md](../../.scratch/skills/PRD.md) 与其 issues。核心：新 `src/skills.ts`（扫两处目录、解析 frontmatter、定位、读正文、拼装 base/args）；`roles.ts` 之外新建，因 skill ≠ 角色；`tools.ts` 加 `skill` 工具（非危险、非辅助）；`agent.ts` 注入 skill 菜单进 `skill` 工具描述、给正文消息打 `{skill:name}` 标记；`context.ts` 的 `serializeForDistill` 加 `dropSkill` 参数、`memory.ts` 传 `true`、`compactor.ts` 传 `false`（拆别名）；`cli.ts` 加 `/skills [reload]`、`/<name>` 分发（内置优先）、用户通道注入两条消息。术语见 CONTEXT.md「Skill 能力」。
