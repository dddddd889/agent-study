# 精确编辑用「字符串替换」(Edit) 而非 diff；强制「先读再改」

## 决策

给 agent 一个精确改代码的能力：新增 **`Edit` 工具 = 唯一命中的字符串替换**（`{ path, old_string, new_string, replace_all? }`），而不是 Codex 式的 `apply_patch`（unified-diff、多 hunk、多文件）。同时把 `read_file` 升级为**分页 + 带行号**（`offset`/`limit`），并强制一条不变量：**`Edit` 前必须先 `read_file` 读过该文件**（read-before-edit）。`write_file` 保留，专管新建 / 整文件重写。

## 为什么选字符串替换而非 diff

考虑过 `apply_patch`（对标 Codex）：一次能改多处/多文件、能增删文件，更强。但补丁格式解析麻烦，模型也更容易生成错（上下文/缩进对不齐 → 整块失败），对一个教学步骤是干扰项。字符串替换实现简单、错误可诊断（0 命中 / 多命中都能给出明确提示逼模型补上下文），覆盖「改一处」的绝大多数场景。多 hunk / 多文件留给未来的 `apply_patch`。

## read-before-edit 的干净实现：per-agent 的 ToolContext.readFiles

强制「先读再改」需要跨工具共享「读过哪些文件」。为避免模块级全局状态（会在主 agent 与子 agent 间串味，也是本仓库刻意避免的「第二真相」），改为**每个 `Agent` 实例持有自己的 `readFiles: Set`，经 `ToolContext` 透传**：

- `read_file`（和 `write_file`，写了即知内容）成功后把 `resolve(path)` 记入集合；
- `Edit` 开头校验 `resolve(path)` 在集合里，否则报错。

主 agent 与每个子 agent 各是独立 `Agent` 实例 → 各有各的 `readFiles`，隔离天然成立、纯运行时（`reset()` 清空）、非持久，不构成第二真相。

## 边界

- **唯一命中**：`old_string` 命中 0 次或多次都报错（多次需 `replace_all`）——把「改错地方」挡在执行前。
- **完整 mtime 陈旧检测**（文件被 shell 改过）留 TODO；本步只做「必须读过」这层。
- **分页 read**：默认 2000 行、单行 ≤2000 字符;输出带行号便于定位,但 `Edit` 的 `old_string` 用**文件真实内容、不含行号前缀**(文档明确警告)。
- **`apply_patch`**（diff / 多 hunk / 增删文件）留作后续增强。
