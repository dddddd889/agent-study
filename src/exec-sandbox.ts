import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { sandboxRoot } from "./sandbox";

// 第 25 步:执行沙箱 —— 把 shell 命令关进【操作系统级】沙箱里跑,补上路径沙箱管不到的
// 「任意命令」这个绕过口。见 docs/25、ADR-0009。
//
// 机制:不解析命令串(白名单是漏的),而是把命令包进内核沙箱启动器:
//   macOS → sandbox-exec -p '<profile>' /bin/sh -c '<command>'   (Seatbelt SBPL)
//   Linux → bwrap --ro-bind / / --dev /dev --bind <root> <root> [--unshare-net] -- /bin/sh -c '<command>'
// 默认策略 = workspace-write:写限工作目录 / 读放开 / 禁网。与权限模式正交(yolo 也被框住)。
// 沙箱不可用 → fail-closed(拒跑 shell)。开关见下。

export interface ExecSandboxConfig {
  enabled: boolean; // AGENT_SANDBOX_EXEC !== "0"
  net: boolean; // AGENT_SANDBOX_EXEC_NET === "1" → 放开网络
  root: string; // 写边界根(复用 AGENT_SANDBOX_ROOT / cwd)
}

// 平台 + 可用沙箱二进制。抽成显式对象,让 wrapCommand 成纯函数、可单测。
export interface SandboxEnv {
  platform: NodeJS.Platform;
  hasSeatbelt: boolean; // macOS sandbox-exec
  hasBwrap: boolean; // Linux bubblewrap
}

// 【校验时】现取,便于测试用 env 切换(同 sandbox.ts 的习惯)。
// root 用 realpath 归一(而非路径沙箱的词法 resolve):内核沙箱按【真实路径】判定,
// macOS 上 /var→/private/var、/tmp→/private/tmp 这类软链不归一会导致连界内写都被拒。
// 这里 root 必然存在(cwd 或真实目录),realpath 安全;失败(极端情况)回退词法值。
export function execSandboxConfig(): ExecSandboxConfig {
  const lexical = sandboxRoot();
  let root = lexical;
  try {
    root = realpathSync(lexical);
  } catch {
    root = lexical;
  }
  return {
    enabled: process.env.AGENT_SANDBOX_EXEC !== "0",
    net: process.env.AGENT_SANDBOX_EXEC_NET === "1",
    root,
  };
}

// 探测某二进制是否在 PATH 上(用 which)。失败即视为不可用。
function hasBinary(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 探测当前环境的可用沙箱,结果缓存(探测要 spawn,别每次 shell 都跑)。
let cachedEnv: SandboxEnv | null = null;
export function execSandboxEnv(): SandboxEnv {
  if (cachedEnv) return cachedEnv;
  const platform = process.platform;
  cachedEnv = {
    platform,
    hasSeatbelt: platform === "darwin" && hasBinary("sandbox-exec"),
    hasBwrap: platform === "linux" && hasBinary("bwrap"),
  };
  return cachedEnv;
}

// SBPL 字符串里的双引号路径:转义反斜杠与双引号(路径极少含,但稳妥)。
function sbplQuote(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// 生成 macOS Seatbelt profile(纯函数)。语义靠「后匹配覆盖前匹配」:
//   allow default → 打底放开(含读全盘) → deny network*(禁网) → deny file-write*(禁写)
//   → allow file-write*(仅工作目录 + 必要 /dev)。
// 只放行 root + 少量 /dev:需要写工作目录外(~/.npm、$TMPDIR)的命令会失败 —— 刻意的紧边界。
export function buildSeatbeltProfile(root: string, opts: { net: boolean }): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    opts.net ? "" : "(deny network*)",
    "(deny file-write*)",
    "(allow file-write*",
    `    (subpath "${sbplQuote(root)}")`,
    '    (literal "/dev/null")',
    '    (literal "/dev/stdout")',
    '    (literal "/dev/stderr")',
    '    (literal "/dev/tty"))',
  ];
  return lines.filter(Boolean).join("\n");
}

// 生成 Linux bwrap 参数(纯函数,不含末尾的 /bin/sh -c command)。
// 整个根文件系统只读挂载,再把工作目录读写绑回来;--dev 给一份干净可写的 /dev;
// 不放网时 --unshare-net 给一个空网络命名空间(物理上连不出去)。
export function buildBwrapArgs(cfg: ExecSandboxConfig): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--bind", cfg.root, cfg.root,
    ...(cfg.net ? [] : ["--unshare-net"]),
    "--",
  ];
}

// 把一条命令包装成【要 spawn 的 argv】{file,args}(纯函数)。
//   - 关沙箱 → 裸跑 /bin/sh -c command;
//   - darwin+seatbelt → sandbox-exec -p profile /bin/sh -c command;
//   - linux+bwrap → bwrap …args… /bin/sh -c command;
//   - 都不满足 → fail-closed 抛错(拒跑 shell)。
export function wrapCommand(
  command: string,
  cfg: ExecSandboxConfig,
  env: SandboxEnv,
): { file: string; args: string[] } {
  if (!cfg.enabled) return { file: "/bin/sh", args: ["-c", command] };

  if (env.platform === "darwin" && env.hasSeatbelt) {
    const profile = buildSeatbeltProfile(cfg.root, { net: cfg.net });
    return { file: "sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command] };
  }
  if (env.platform === "linux" && env.hasBwrap) {
    return { file: "bwrap", args: [...buildBwrapArgs(cfg), "/bin/sh", "-c", command] };
  }
  throw new Error(
    "本平台没有可用的执行沙箱（需 macOS sandbox-exec 或 Linux bwrap）——" +
      "为安全起见 shell 已被禁用（fail-closed）；" +
      "确要在无沙箱下裸跑命令，设 AGENT_SANDBOX_EXEC=0。",
  );
}
