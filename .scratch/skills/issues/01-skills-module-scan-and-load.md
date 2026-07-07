# 01 skills 模块：扫描 / frontmatter / 定位 / 读正文 + 拼装

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0014](../../../docs/adr/0014-skills-in-context-on-demand-instruction-packages.md)

## 背景

skill 的全部领域逻辑收在一个新模块 `src/skills.ts`——扫两处目录、解析 frontmatter 建菜单、按名定位、读正文并拼装。不碰 agent、不碰 CLI，离线可测。**新建模块而非塞进 `roles.ts`**：skill ≠ 角色（一个在当前上下文注指令、一个是隔离子 agent 的人格）。

## 范围

**`src/skills.ts`**：

1. `type SkillMeta = { name: string; description: string; disableModelInvocation: boolean; dir: string }`——菜单条目（不含正文）。
2. `scanSkills() → SkillMeta[]`：扫 `.claude/skills/`（项目级）+ `~/.claude/skills/`（用户级，用 `os.homedir()`）。每个子目录读 `SKILL.md`、**只解析 frontmatter**（不读正文进内存）。`name` **取目录名**（frontmatter 里的 name 忽略/仅校验）。**同名项目覆盖用户**（项目级后扫或用 Map 覆盖）。可用 `AGENT_SKILLS_DIR` 覆盖项目级根，供测试隔离。
3. `loadSkillBody(meta, args?) → string`：调用时**现读** `<dir>/SKILL.md`、剥 frontmatter 取正文；正文**顶部**加一行 `Base directory for this skill: <abs dir>`、若有 `args` **尾部**加 `\n\nARGUMENTS: <args>`。返回拼好的正文文本。
4. frontmatter 解析：一个极小的 YAML 子集解析器即可（`key: value`，`disable-model-invocation` 认 `true`/`false`），或复用项目已有解析工具（先 grep 确认有无）。**零新依赖**优先，与仓库「零运行时依赖」一致。

**加载软失败（关键）**——`scanSkills` 逐目录 try：无 `SKILL.md` / 缺 `description` / frontmatter 解析失败 / 目录名非合法命令 token（建议 `^[a-z0-9][a-z0-9-]*$`）→ **跳过该 skill + 收集一条 warning**，绝不抛。返回 `{ skills: SkillMeta[]; warnings: string[] }` 让上层（CLI）决定怎么显示 warning。

## 验收标准

- `scanSkills`：项目级 + 用户级都被扫到；同名时项目级胜出；`disable-model-invocation: true` 正确解析进 `disableModelInvocation`。
- 软失败：造一个缺 `description`、一个坏 YAML、一个非法目录名、一个无 `SKILL.md` 的目录 → 各被跳过并各产一条 warning，其余正常 skill 不受影响、`scanSkills` 不抛。
- `loadSkillBody`：正确剥除 frontmatter；正文顶部有 `Base directory:` 行；给 args 时尾部有 `ARGUMENTS:` 行、不给则无。
- `name` 恒等于目录名（frontmatter 写了别的 name 也以目录名为准）。
- 纯模块：不依赖 `agent.ts` / `cli.ts` / `tools.ts`。

## 测试

`tests/skills.test.ts`：用临时目录作 `AGENT_SKILLS_DIR`（+ 一个假 home）搭若干 skill 目录。断言：双源扫描、项目覆盖用户、disabled 解析、四类坏 skill 各自跳过 + warning、正文拼装（frontmatter 剥离 / Base directory 行 / ARGUMENTS 有无）。
