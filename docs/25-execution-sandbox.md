# 第 25 步：执行沙箱（把 shell 关进操作系统级沙箱）

> 到第 24 步，路径沙箱（第 23 步）把**我们自己的文件工具**框在了工作目录内，但 **`shell` 是绕过口**：它跑任意命令串，`cat ../../etc/passwd`、`curl 外发`、`rm -rf` 照样能干，路径沙箱管不到。权限模式（第 24 步）也只能「问 / 拒」，`yolo` 下更是裸奔。这一步给 `shell` 加一道**内核强制**的硬边界。

## 核心：包进 OS 级沙箱，而不是解析命令串

命令白名单/黑名单是**漏的**——`$(...)`、`;`、`a=rm;$a -rf`、`base64 -d|sh`、别名……绕过方式无穷，还教错人（以为「过滤字符串 = 安全」）。所以走 Codex CLI 同款路子：把命令**包进操作系统的沙箱启动器**里跑，由内核框住**任意**命令及其所有子进程。

[src/exec-sandbox.ts](../src/exec-sandbox.ts)：

| 平台 | 包装 |
|---|---|
| macOS | `sandbox-exec -p '<profile>' /bin/sh -c '<command>'`（Seatbelt SBPL，动态生成） |
| Linux | `bwrap --ro-bind / / --dev /dev --bind <root> <root> [--unshare-net] -- /bin/sh -c '<command>'` |
| 其它 / 二进制缺失 | **fail-closed**：拒跑 shell，提示设 `AGENT_SANDBOX_EXEC=0` |

用 **argv 数组** `execFile("sandbox-exec", ["-p", profile, "/bin/sh", "-c", command])` spawn，避开把 profile+命令拼成一个大 shell 串的引号地狱。命令仍在 `/bin/sh -c` 下，管道/`&&`/`$()` 照常；30s 超时 + Ctrl+C 中断保留。

## 默认策略：workspace-write（写限 / 读放开 / 禁网）

对标 Codex 的同名档：

- **写**：只能落在工作目录内（复用 `AGENT_SANDBOX_ROOT`，默认 cwd）+ 必要的 `/dev/null|stdout|stderr|tty`。
- **读**：**放开全盘**。否则 `git`、跑测试、找工具（读 `/usr/lib`、`/etc`）全崩。
- **网络**：**默认禁**。

「读放开 + 禁网」的组合是关键：**读得到密钥也发不出去**——沙箱禁网后 `curl` 连 socket 都建不了。禁网还顺带堵 [SSRF](adr/0009-execution-sandbox-os-level-workspace-write.md)（云元数据 `169.254.169.254`、内网网段）。禁网会挡正当联网（`npm install`），故留 `AGENT_SANDBOX_EXEC_NET=1` 开关。

### Seatbelt profile 长这样

```
(version 1)
(allow default)          ; 打底放开(含读全盘)
(deny network*)          ; 禁网(放网时这行不生成)
(deny file-write*)       ; 先禁所有写
(allow file-write*       ; 再只放行工作目录 + 必要 /dev(后匹配覆盖前匹配)
    (subpath "<root>")
    (literal "/dev/null") (literal "/dev/stdout")
    (literal "/dev/stderr") (literal "/dev/tty"))
```

> **realpath 归一**：内核沙箱按**真实路径**判定。macOS 上 `/var→/private/var`、`/tmp→/private/tmp`，root 若用路径沙箱那种**词法** `resolve` 不归一，连界内写都会被拒。所以执行沙箱对 root 用 `realpathSync`（root 必然存在，安全）——与路径沙箱刻意的词法判定不同（那是为了校验尚不存在的新文件）。

## 与权限模式正交

权限模式（第 24 步）管「**要不要问**」，执行沙箱管「**放行后怎么跑**」。两者独立：

- **`yolo` 下 shell 仍被沙箱框住**（不问、但写限 cwd + 禁网）。这补上了第 24 步 TODO 里「yolo 下 shell OS 层越界」——**yolo 不再等于裸奔**。
- 要完全裸跑，得**显式** `AGENT_SANDBOX_EXEC=0`（像 Codex 的 `danger-full-access`）。

## fail-closed：不保则拒

沙箱不可用（无 `sandbox-exec`/`bwrap`，或 Windows）→ **拒跑 shell**，回一条 is_error 提示，而不是静默裸跑。护栏的本分是「不能保证安全就不干」，与路径沙箱「默认开」一脉相承。

## 开关（env）

- `AGENT_SANDBOX_EXEC=0`：关执行沙箱（shell 裸跑）。
- `AGENT_SANDBOX_EXEC_NET=1`：放开网络（装依赖时用）。
- `AGENT_SANDBOX_ROOT`：写边界根（与路径沙箱**同一个根**，概念统一）。

## 边界与已知取舍

- **只管 `shell`**：`http_request`（agent 自己发的请求）走自身校验，它的 SSRF 防护留 TODO；MCP 外部工具在各自进程里跑，不在本沙箱内。
- **`sandbox-exec` 被 Apple 标 deprecated**：但仍可用、且是 Codex/CC 现行做法；stderr 的弃用警告会被吞掉。
- **profile 只放行 root + 少量 `/dev`**：要写 `~/.npm`、`$TMPDIR` 等工作目录外位置的命令会失败——刻意的紧边界，需要就关沙箱或把根设大。

## 测试（`bun test`）

[tests/exec-sandbox.test.ts](../tests/exec-sandbox.test.ts)：
- **纯函数单测**（离线、跨平台）：Seatbelt profile 生成（root 嵌入 / 禁网开关）、bwrap 参数（绑定 root 可写 / `--unshare-net` 开关）、`wrapCommand` 拼 argv（关沙箱裸跑 / darwin-seatbelt / linux-bwrap / 无沙箱 fail-closed 抛错）。
- **集成测试**（仅 macOS + `sandbox-exec`，否则 skip）：真跑一条「写工作目录内」应**成功**、「写工作目录外」应**被拒且文件没建**——直接验证内核确实在拦。

（`tools.test.ts` 的 shell 用例测的是命令语义，设 `AGENT_SANDBOX_EXEC=0` 裸跑，不受本步影响。）

## 下一步

- **`http_request` 的 SSRF 防护**：禁 `169.254.169.254`/内网 IP、限协议、超时（补上「shell 之外」的外连口子）。
- **可配置沙箱策略**：把 workspace-write / read-only / full-access 做成档位（对标 Codex sandbox 模式），并与权限模式联动。
- **符号链接逃逸防护**（路径沙箱那侧，第 23 步 TODO）。
