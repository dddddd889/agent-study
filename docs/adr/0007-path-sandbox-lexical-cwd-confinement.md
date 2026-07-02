# 路径沙箱：词法归一的 cwd 硬边界（shell 除外，软链留 TODO）

## 决策

给所有「按路径操作文件」的工具（`read_file` / `write_file` / `edit_file` / `apply_patch` / `glob` / `grep`）加一条**硬边界**：路径必须落在**工作目录（cwd）**内，否则拒绝。统一收口在 `src/sandbox.ts` 的 `resolveInSandbox(path)`：

```
root = resolve(AGENT_SANDBOX_ROOT ?? cwd)
abs  = resolve(root, path)
若 abs !== root 且 !abs.startsWith(root + sep) → throw（is_error）
否则返回 abs（同时用作 fs 操作 + readFiles 键）
```

**默认开启**;`AGENT_SANDBOX=0` 关闭、`AGENT_SANDBOX_ROOT` 改根，均在**校验时**从 env/cwd 现取。

## 为什么这样

- **词法归一（`path.resolve`）而非 `realpath`**：词法检查挡住 `../../etc/passwd`、绝对路径、`./a/../../b` 这些**真实高频**的穿越;且**不碰文件系统** → 新建文件（还不存在）天然可校验。`realpath` 能防软链逃逸,但对不存在的新文件会抛错、要「父目录 realpath + 拼名」特殊处理,还有跨平台/性能成本 —— 复杂度不值当。**符号链接逃逸**（根内软链指向根外，词法放过、真读写跟随链接跑出去）作为**已知局限**留 TODO。

- **硬拒绝，不「越界转批准」**：沙箱是一条干净的硬边界;想整体放开走全局开关 `AGENT_SANDBOX=0`,而不是逐次弹批准。「越界需批准」这种细粒度耦合到**权限模式**（下一步单独做），本步不掺。

- **默认开**：安全护栏默认不生效等于没有。代价:现有 fs 测试往 `os.tmpdir()`（cwd 外）写,需设 `AGENT_SANDBOX=0`;沙箱本身另写测试覆盖。

- **`shell` 不在范围内**：它跑任意命令字符串,没法用「校验一个 path」框住（要靠 OS 级沙箱/命令白名单,是另一件大事）。**shell 因此是本沙箱的绕过口** —— 继续靠危险工具审批兜着,文档明确点出。

## 边界

- **符号链接逃逸**不防（TODO：如需，改 `realpath` + 处理新文件）。
- **shell 绕过**：`shell` 能读写 cwd 外（`cat ../../etc/passwd`）—— 审批是它唯一的闸。
- **grep/glob**：只校验遍历根在界内;遍历从根**往下**走,不会向上逃逸（软链除外）。
- 与**权限模式**（下一步）解耦：本步只给「硬边界」,可批准逃逸/模式切换留给权限模式统一设计。
