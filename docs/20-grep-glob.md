# 第 20 步：结构化检索（grep / glob）

> 编码闭环是「**找 → 读 → 改**」。第 19 步做了「读、改」；「找」现在只能靠 `shell` 里裸跑 `grep`/`find`——输出杂、跨平台不一、命令易写错、还占审批。这一步补两个**只读检索**工具：`glob`（按名找文件）、`grep`（按内容搜）。

## 为什么不直接用 `shell` 搜

`shell` 能搜，但那是「让模型自己拼一条正确命令」；专用工具是「把搜索做成窄入口」：

- **出错率**：`shell` 要拼对 `find ... \( -name ... \)`、引号、转义、平台差异（本仓库真见过子 agent 把 `find` 写错还重跑）；`glob` 只填 `{ pattern: "src/**/*.ts" }`，几乎错不了。
- **输出**：`shell` 吐裸文本（可能巨大、混 stderr、带颜色码）；工具给结构化 `file:line:内容` + 可控上限。
- **噪音**：`grep -r` 默认搜进 `node_modules`/`.git`；工具默认跳过 + 读 `.gitignore`。
- **跨平台/无依赖**：纯 JS 遍历，Node/Bun 一致，不依赖 `rg`/`find` 装没装。
- **审批**：`glob` 只读免审批；`shell` 是最危险工具、每次搜都要过审批。

`shell` 留给它真正独有的活（跑测试、git 等）。

## 实现：纯 JS 手写（[src/search.ts](../src/search.ts)）

零依赖、跨运行时，和 htmlToMarkdown / MCP 客户端一个路子。**为什么不 shell-out 调 `rg`/`find`**：我们做检索工具就是为了摆脱 shell 搜索，再去 shell 反而没摆脱（还多个「rg 装没装」的依赖）。

- **`glob { pattern, path? }`** → 相对路径列表。支持 `*`（段内）、`**`（任意层）、`?`。**只返回路径、不返回内容**。
- **`grep { pattern, path?, glob?, ignore_case? }`** → `相对路径:行号:该行`。`pattern` 是 JS 正则；`glob` 可限定文件范围；跳二进制（含 null 字节）。

## 跳过：简化 `.gitignore` + 硬编码基线

`shouldSkip(relPath)` = 两者并集，`glob`/`grep` 共用：

- **硬编码基线（始终跳）**：`.git`、`node_modules`、`.DS_Store` —— 没 `.gitignore` 也不裸奔。
- **简化 `.gitignore`**（只读工作区根那一个）：支持普通名（`dist`）、目录式（`dist/`）、后缀（`*.log`）、前导锚定（`/build`）；**不支持**否定 `!`、子目录嵌套 `.gitignore`、复杂 `**` 组合（留 TODO）。

## 搜被忽略的目录：`no_ignore`

默认跳 `.gitignore` 很合理，但当你**明确想看被忽略的目录**（如 `tmp/`、`.sessions/`）时，glob 会静默返回空、模型只好绕回 `shell ls`——违背初衷。两点补救：

- **空结果会解释原因**：`（无匹配 tmp/**/*；注意默认跳过 .gitignore 目录(如 tmp/),要搜它们传 no_ignore: true）` —— 把「为什么空 + 怎么办」写进消息，模型能自我纠正。
- **`no_ignore: true`**（glob/grep 都有，对标 ripgrep 的 `--no-ignore`）：连 `.gitignore` 忽略的也搜，但**仍跳** `.git`/`node_modules` 基线。

## `glob` 免审批、`grep` 走审批（防读绕过）

- **`glob` 非 `dangerous`**：只返回文件名，风险低 → 免审批，搜起来顺。
- **`grep` 标 `dangerous`**：它返回文件**内容**（命中行可能含密钥），而本仓库的 `read_file` 就是 `dangerous`。若 `grep` 非 dangerous，`grep "" 某文件` 就能**绕过读审批**把内容捞出来。所以 `grep` 和 `read_file` 一致走审批，堵住这个洞。即便批准，`grep` 也只能搜、不能像 `shell` 执行任意命令，安全得多。

> 这条「改个 flag 就能翻」的决定不够 ADR 门槛，所以只记在这里：**返回内容的检索必须和 read 同等对待**。

## 上限（防大仓库冲爆内存/上下文）

- `glob`：命中文件 **200** 封顶；
- `grep`：命中行 **100** 封顶、单行 **2000** 字符封顶、跳二进制；
- 遍历文件数硬上限 **5000**（兜底病态大目录）。
- 超限都给「请收窄」提示。

## 引导模型去用它（否则它还是用 shell 的 find/grep）

和第 14 步 todo、第 15 步子 agent 一样的一课：**工具存在 ≠ 模型会用**。刚加完 `glob`/`grep`，模型往往仍旧 `shell` + `find`/`grep` —— 因为它有 shell 肌肉记忆，而提示里没拦。两处引导（缺一模型就会退回 shell）：

1. **`baseSystem`（[src/cli.ts](../src/cli.ts)）** 明确分工：找文件用 `glob`、搜内容用 `grep`、改文件用 `edit_file`；`shell` 只留给跑测试/git 等，**别用 shell 的 `find`/`grep`/`ls`/`cat`**。
2. **`shell` 工具描述（[src/tools.ts](../src/tools.ts)）** 加「改道」警告：找文件/搜内容/读文件请分别用 `glob`/`grep`/`read_file`。让模型在**工具层**就看到「找文件别用我」。

> 提示引导不是 100% 服从。若仍偶发用 shell 检索，可加重措辞，或在 `shell` 里对 `find`/`grep` 命令做**软性拦截**（返回「请改用 glob/grep」）——更硬但更啰嗦，按需再上。

## 测试（`bun test`，离线）

[tests/search.test.ts](../tests/search.test.ts)：`glob` 的 `**`/段内匹配 + 跳 node_modules/.gitignore；`grep` 的 `file:line:内容` 输出、`glob` 限定范围、`ignore_case`、跳二进制、非法正则报错；`glob` 非 dangerous / `grep` dangerous。

## 下一步

- **apply_patch**：Codex 风格多 hunk diff 补丁。
- **路径沙箱 + 权限模式**：把 read/write/edit（和 grep 的读）限制在工作目录内 + 会话级审批模式。
- **完善 `.gitignore`**：否定规则、嵌套 `.gitignore`。
