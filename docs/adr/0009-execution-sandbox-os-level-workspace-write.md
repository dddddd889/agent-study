# 执行沙箱：OS 级包装 shell（workspace-write，fail-closed，与权限模式正交）

## 决策

给 `shell` 加**操作系统级沙箱**——把命令包进内核沙箱启动器里跑，而非解析命令串：

- **macOS**：`sandbox-exec -p '<profile>' /bin/sh -c '<command>'`，profile（Seatbelt SBPL）动态生成。
- **Linux**：`bwrap --ro-bind / / --dev /dev --bind <root> <root> [--unshare-net] -- /bin/sh -c '<command>'`。
- **其它平台 / 二进制缺失**：**fail-closed** —— 拒跑 shell，回 is_error 提示「设 `AGENT_SANDBOX_EXEC=0` 裸跑」。

默认策略 = **workspace-write**：**写**限工作目录（复用 `AGENT_SANDBOX_ROOT`，默认 cwd）+ 必要的 `/dev/null|stdout|stderr|tty`；**读**放开全盘；**网络**默认禁。

代码收口在 `src/exec-sandbox.ts`：`buildSeatbeltProfile(root,{net})`、`buildBwrapArgs(cfg)`、`wrapCommand(command,cfg,env)→{file,args}`（纯函数）+ `execSandboxEnv()`（探测二进制，缓存）。`shellTool.run` 用 `execFile(file,args,{timeout,signal})` 跑包装后的 argv。

开关：`AGENT_SANDBOX_EXEC=0` 关、`AGENT_SANDBOX_EXEC_NET=1` 放网、`AGENT_SANDBOX_ROOT` 定写边界根。

## 为什么这样

- **OS 级 > 命令白名单**：白名单解析命令串根本挡不住 `$(...)`、`;`、`a=rm;$a -rf`、`base64 -d|sh`、别名。更糟是**教错**——让人以为「过滤字符串 = 安全」。内核沙箱框住**任意**命令及其所有子进程，是唯一真边界。对标 Codex CLI（mac Seatbelt / Linux Landlock+seccomp）。

- **workspace-write（写限 / 读放开 / 禁网）**：读若也限工作区，`git`/跑测试/找工具（读 `/usr/lib`、`/etc`）全崩，没法干活。所以**读放开**，靠**禁网**兜底——读到 `/etc/passwd`、`~/.ssh/id_rsa` 也**发不出去**（`curl` 连不出 socket）。禁网还顺带堵 SSRF（云元数据 `169.254.169.254`、内网）。禁网会挡正当联网（`npm install`），故**留 `AGENT_SANDBOX_EXEC_NET=1` 开关**。

- **argv 数组 spawn，不拼大字符串**：`execFile("sandbox-exec",["-p",profile,"/bin/sh","-c",command])`，避开 profile+命令拼进一个 shell 串的引号地狱。命令仍在 `/bin/sh -c` 下，管道/`&&`/`$()` 照常；保留 30s 超时 + Ctrl+C 中断。

- **与权限模式正交**：权限模式管「要不要问」，执行沙箱管「放行后怎么跑」。所以 **`yolo` 下 shell 仍被沙箱框住**（不问、但写限 cwd + 禁网）；要完全裸跑得**显式** `AGENT_SANDBOX_EXEC=0`。这补上了第 24 步 TODO 里「yolo 下 shell OS 层越界」的口子——yolo 不再等于裸奔。

- **fail-closed**：沙箱不可用就拒 shell，而非静默裸跑。护栏的本分是「不能保证安全就不干」，与路径沙箱「默认开」一脉相承。

## 边界

- **只管 `shell`**：`http_request`（agent 自己发的请求）走自身校验，它的 SSRF 防护（禁 `169.254.169.254`/内网 IP）是**另一件事，留 TODO**；MCP 外部工具在各自进程里跑，不在本沙箱内。
- **`sandbox-exec` 被 Apple 标 deprecated**：但仍可用、且是 Codex/CC 现行做法。stderr 的弃用警告会被吞掉。
- **profile 只放行 root + 少量 `/dev`**：需要写 `~/.npm`、`$TMPDIR` 等**工作目录外**位置的命令会失败——这是刻意的紧边界，需要就 `AGENT_SANDBOX_EXEC=0` 或把根设大。
- **与路径沙箱正交**（ADR-0007）：路径沙箱管我们自己的文件工具、词法层；执行沙箱管 shell 子进程、内核层。两者复用同一个 `AGENT_SANDBOX_ROOT`。
- **强隔离靠集成测试**：profile 生成 / argv 拼装是纯函数可单测；真实施靠 darwin + `sandbox-exec` 门控的集成测试（写 cwd 外应失败、写 cwd 内应成功），其它环境 skip。
