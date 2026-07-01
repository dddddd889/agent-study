# 第 19 步：精确编辑（Edit）+ 分页 read

> 前面改文件只有 `write_file`（整文件覆盖）—— 这是玩具级：改一行也要重写整个文件、容易误删。真正的编码 agent（Codex / Claude Code）改代码靠**精确编辑**。这一步补上「找 → 读 → 精确改」的编码闭环。

## 三件事

1. **`read_file` 分页 + 带行号** —— 大文件不再一次灌爆上下文。
2. **`edit_file` 精确字符串替换** —— 改一处，不重写整文件。
3. **read-before-edit 不变量** —— 没读过的文件不许改（防盲改）。

`write_file` 保留，专管**新建 / 整文件重写**；改一处用 `edit_file`。

## `read_file`：分页 + 行号

`{ path, offset?, limit? }`，输出每行带**行号 + Tab** 前缀（`  42\t內容`）：

- 默认从头读 **2000 行**；超出提示「继续用 offset=…」；单行超 **2000 字符**省略（防压缩行炸上下文）。
- 行号是为了**定位**（报 `file:line`、决定下一段读哪）。

> ⚠️ **最容易踩的坑**：行号只是显示。用 `edit_file` 时，`old_string` 要用文件的**真实内容**，**不含**这个「行号 + Tab」前缀 —— 否则永远匹配不上。`read_file` 和 `edit_file` 的工具描述都写了这条警告。

## `edit_file`：唯一命中的字符串替换

`{ path, old_string, new_string, replace_all? }`（对标 Claude Code 的 `Edit`）：

- **精确匹配**（含缩进/空白）；
- **命中 0 次 → 报错**「请给更精确/更长的上下文」；
- **命中多次 → 报错**「不唯一，扩上下文或用 `replace_all`」；`replace_all: true` 才批量替；
- `new_string` 留空 = **删除**那段；
- 成功回显「已替换 N 处」+ 改动处**前后小片段**，便于确认改对地方。

「唯一命中」这条把「改错地方」挡在执行前 —— 与其信任行号（会漂移），不如让模型给一段唯一的上下文。为什么不用 Codex 的 `apply_patch`（diff/多 hunk/多文件）？那更强但格式解析麻烦、模型也更易生成错，留作后续增强。见 [ADR-0005](adr/0005-edit-by-string-replace-and-read-before-edit.md)。

## read-before-edit：干净的 per-agent 实现

`edit_file` 前必须先 `read_file`（或 `write_file`，写了即知内容）读过该文件。实现上**没有用模块级全局**（那会在主/子 agent 间串味，也是本仓库刻意避免的第二真相），而是：

- `ToolContext` 加一个 `readFiles?: Set<string>`；
- **每个 `Agent` 实例持有自己的 `readFiles`**，调工具时经 `ctx` 透传（[src/agent.ts](../src/agent.ts)）；
- `read_file`/`write_file` 成功后 `ctx.readFiles.add(resolve(path))`；`edit_file` 校验 `resolve(path)` 在集合里，否则报错。

主 agent 与每个子 agent 各是独立 `Agent` → 各有各的 `readFiles`，**隔离天然成立**；纯运行时、`reset()` 清空、不持久。路径用 `path.resolve` 归一，避免相对/绝对不一致。完整的 mtime 陈旧检测（文件被 shell 改过）留 TODO —— 本步先做「必须读过」这层。

## 测试（`bun test`，离线）

[tests/edit.test.ts](../tests/edit.test.ts)：

- **分页 read**：带行号、`offset/limit` 取中间几行 + 续读提示；read 成功记入 `readFiles`；
- **edit 语义**：唯一命中替换、0 命中报错、多命中报错 / `replace_all` 全替、空 `new_string` 删除；
- **read-before-edit**：没读过 → 报错；`write_file` 写后算已读、可直接 edit。

## 下一步

- **`apply_patch`**：Codex 风格的 diff 补丁（一次多 hunk / 多文件 / 增删文件）。
- **路径沙箱**：把 `read`/`write`/`edit` 限制在工作目录内（堵 `../../etc/passwd`）。
- **grep / glob**：结构化检索，补齐「找 → 读 → 改」的「找」。
