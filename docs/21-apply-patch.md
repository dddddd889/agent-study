# 第 21 步：apply_patch（跨文件原子补丁）

> `edit_file`（第 19 步）一次只改一处、一个文件。做「重命名一个函数、5 个文件 12 处」这种，得调十几次。`apply_patch` 用 Codex 风格补丁**一次性、跨多文件、含增删文件**地改，且**全或无原子**。

## 先厘清：Claude 其实不用补丁

问过 Claude Code 怎么做编辑（见对话）：它是**纯字符串替换**（`Edit` = 我们的 `edit_file`）+ `Write`，多处就**发多个 Edit 调用**，没有 diff/patch 工具（`MultiEdit` 也已废弃）。而 **`apply_patch` 是 Codex 的东西**。所以这一步补的是 Codex 那条路——`edit_file` 没有的「跨文件原子 + 一次增删批量」。三个编辑工具分工：

- `edit_file`：单处精确改；
- `write_file`：单文件新建/整体重写；
- `apply_patch`：跨文件批量 + 增删文件，**原子**。

## 核心洞察：补丁是模型生成的，必然有瑕疵

`apply_patch` 的 `patch` 参数**由大模型生成**（它决定调用时把整段补丁当 tool 输入吐出来）。模型会抄少上下文、缩进差一格、尤其**算不准行号**。所以设计目标不是「完美 diff」，而是「**容忍不完美的 diff**」（[ADR-0006](adr/0006-apply-patch-content-located-atomic.md)）：

### 1. 内容定位，不靠行号
每个 hunk 还原成「**旧块**（上下文行 + `-` 行）→ **新块**（上下文行 + `+` 行）」，在文件当前内容里**精确、唯一**命中旧块再替换。补丁头 `@@ -l,c +l,c` 的行号**忽略**。

**为什么**：unified diff 靠行号硬定位，模型算错、或前一个 hunk 增删导致后面行漂移，就整块错位。内容定位**天然免疫行漂移**——同一文件多个 hunk 在**内存副本上按序应用**，后一个在前一个改完的内容里按内容再找，绝对行号无所谓。（测试里就有「先插一行、后一个 hunk 仍命中」的用例。）

### 2. 全或无原子
先解析整补丁 + 校验所有前置 + 在内存里算出每个文件最终内容，**任何一处失败就整补丁拒绝、一个字节不写**；全通过才一起落盘。唯一失败模式是「旧块命中 0 次或多次」→ 原子中止 + 可诊断报错，模型据此**改补丁重试**，不会错改一半。

## 前置条件

- `Update`/`Delete`：文件**必须先 `read_file` 读过**（read-before-edit，复用第 19 步的 per-agent `readFiles`）+ 文件须存在；
- `Add`：目标**必须尚不存在**（防覆盖）；
- 应用后：`Update`/`Add` 路径记入 `readFiles`，`Delete` 移除。

## 格式（工具描述里带完整示例教模型）

我们跑的是 **Claude**，而 `*** Begin Patch` 是 Codex 原生格式、Claude 不天生熟——所以 `apply_patch` 的工具描述里**内嵌一个完整示例**，提高生成成功率：

```
*** Begin Patch
*** Update File: 相对路径
@@
 上下文行(前一个空格)
-删除行(前一个减号)
+新增行(前一个加号)
*** Add File: 相对路径
+新文件每一行
*** Delete File: 相对路径
*** End Patch
```

`@@` 分隔同一文件的多个 hunk（其后内容仅提示、不参与匹配）。

## 审批与回显

- `dangerous: true` 走人工确认（弹问显示整段补丁）；**不标 `concurrent`**（改文件、讲顺序，与 edit/write 一样串行）。
- 成功按文件回显：`已应用补丁：Update foo.ts(+3 -1)；Add new.ts(+10)；Delete old.ts`。

## 测试（`bun test`，离线）

[tests/patch.test.ts](../tests/patch.test.ts)：解析三类段 + 格式错；多 hunk 更新（**行漂移仍命中**）、Add、Delete、多文件；**原子**（后一个文件 hunk 失败 → 前一个也不写）、不唯一→失败；前置（Update 未 read、Add 已存在）；`dangerous`/非 `concurrent`。

## 已知问题 / 待办（第 21 步使用中暴露）

**本步自身的局限：**
1. **格式非 Claude 原生**：`*** Begin Patch` 是 Codex 格式，Claude 可能吐成 unified diff / 漏标记 → `parsePatch` 报「补丁格式错误」。目前靠工具描述里的示例引导，实际成功率待观察；必要时可加「格式不对时给更具体的纠正提示」。
2. **补丁受 `max_tokens`**：超大跨文件补丁可能被输出截断 → tool_use 参数残缺。应在提示里引导「太大就拆成多次 apply_patch」。
3. **无 fuzzy 匹配**：上下文行必须逐字精确，模型抄错一个空格就 0 命中（这是「内容定位」的取舍，安全但偶有摩擦）。
4. **不支持 rename/move**：现用「Delete + Add」凑；Codex 的 `*** Move to:` 留 TODO。

**使用中暴露的相邻问题（不止本步，待办）：**
5. **maxSteps 报错文案误导**：逐个 `edit_file` 改很多处会撞 `maxSteps`，但报错说「可能陷入循环」——其实是任务规模问题。应改成提示「用 apply_patch 批量 / 调大 `AGENT_MAX_STEPS` / 拆子 agent」。（`src/agent.ts`）
6. **`bun test` 误跑 `tmp/` 实验测试**：`package.json` 的裸 `bun test` 扫全项目（含 gitignored 的 `tmp/`），会把 agent 实验产生的坏测试也跑了。应把脚本收窄到 `bun test tests/`。

## 下一步

- **rename/move**（Codex 的 `*** Move to:`）——目前用「删+增」凑。
- **路径沙箱 + 权限模式**：把 read/write/edit/patch/grep 关进工作目录 + 会话级审批模式。
