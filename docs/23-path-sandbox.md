# 第 23 步：路径沙箱（把文件工具关进工作目录）

> 到第 22 步，agent 已能自由 `read`/`write`/`edit`/`apply_patch`/`grep`/`glob`——但**毫无边界**：`read_file ~/.ssh/id_rsa`、`write_file ../../etc/x` 都能干（只要过审批）。这一步给所有「按路径操作文件」的工具加一条**硬边界**：只能在工作目录（cwd）内。

## 核心：一个 `resolveInSandbox` 收口所有校验

[src/sandbox.ts](../src/sandbox.ts)：

```ts
root = resolve(AGENT_SANDBOX_ROOT ?? cwd)
abs  = resolve(root, 用户路径)
若 AGENT_SANDBOX=0 → 直接返回 abs（关闭）
若 abs === root 或 abs.startsWith(root + 分隔符) → 返回 abs（界内）
否则 → throw「路径超出工作目录沙箱」（is_error）
```

所有文件工具一行接入，返回的 `abs` 同时用作 fs 操作路径 + `read-before-edit` 的 `readFiles` 键（保持一致）：

| 工具 | 接入 |
|---|---|
| `read_file` / `write_file` / `edit_file` | `resolveInSandbox(path)` 取代原来的 `resolve(path)` |
| `apply_patch` | 每个 op 路径 `resolveInSandbox(op.path)`；越界在**校验阶段**抛错 → 整补丁不写（延续原子性） |
| `grep` / `glob` | 校验**遍历根** `input.path` 在界内；遍历从根**往下**走，不会向上逃逸 |

## 关键取舍（见 [ADR-0007](adr/0007-path-sandbox-lexical-cwd-confinement.md)）

- **词法归一（`path.resolve`）而非 `realpath`**：挡住 `../../etc/passwd`、绝对路径、`./a/../../b` 这些**真实高频**穿越；且**不碰文件系统** → 新建文件（还不存在）也能校验。代价：**不防符号链接逃逸**（根内软链指向根外，词法放过、真读写跟随链接跑出去）→ 留 TODO。
- **硬拒绝，不「越界转批准」**：沙箱是干净硬边界；整体放开用 `AGENT_SANDBOX=0`，而不是逐次弹批准。「越界需批准」耦合到**权限模式**（下一步），本步不掺。
- **默认开**：安全护栏默认不生效等于没有。代价：现有 fs 测试往 `os.tmpdir()`（cwd 外）写 → 给它们设 `AGENT_SANDBOX=0`；沙箱本身用 [tests/sandbox.test.ts](../tests/sandbox.test.ts) 覆盖。
- **前缀防误判**：判 `abs.startsWith(root + 分隔符)` 而非 `startsWith(root)`，否则 `/work-evil` 会被误当成 `/work` 的界内。

## ⚠️ shell 是沙箱的绕过口

`shell` **不在本沙箱范围内**——它跑任意命令字符串，没法用「校验一个 path」框住（要靠 OS 级沙箱 / 命令白名单，是另一件大事）。所以 `cat ../../etc/passwd`、`rm -rf /` 这类**仍能越界**，唯一的闸是**危险工具审批**。真正收紧要等「权限模式 / 执行沙箱」那步。

## 开关与根（env，校验时现取）

- `AGENT_SANDBOX=0`：关闭沙箱（需临时访问 cwd 外时）。
- `AGENT_SANDBOX_ROOT=/path`：改沙箱根（默认 cwd）。

## 测试（`bun test`，离线）

[tests/sandbox.test.ts](../tests/sandbox.test.ts)：界内相对路径归一、`../` 与绝对路径越界抛错、前缀误判（`/sbx/root-evil`）被拦、`AGENT_SANDBOX=0` 放行、`AGENT_SANDBOX_ROOT` 覆盖根。（该文件显式控制 env，不受其它 fs 测试设 `=0` 的串味。）

## 下一步

- **符号链接逃逸防护**（`realpath` + 处理新文件）。
- **权限模式 / 执行沙箱**：会话级审批策略（自动批准编辑 / 只读 / plan）+ 收紧 shell（OS 级沙箱 / 命令白名单）——本步的「越界需批准」「shell 绕过口」都留给它。
