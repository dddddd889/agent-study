import { resolve, sep } from "node:path";

// 第 23 步:路径沙箱 —— 把「按路径操作文件」的工具限制在工作目录内,堵路径穿越
// (../../etc/passwd、绝对路径等)。见 docs/23、ADR-0007。
//
// 默认开启;AGENT_SANDBOX=0 关闭;AGENT_SANDBOX_ROOT 改根(默认 cwd)。都在【校验时】现取,
// 便于测试用 env 切换。词法归一(path.resolve)判定,不碰文件系统 → 新建文件也能校验;
// 不防符号链接逃逸(留 TODO)。shell 不在范围内(它跑任意命令,靠审批兜着)。

// 沙箱根:AGENT_SANDBOX_ROOT 或 cwd,归一成绝对路径。
export function sandboxRoot(): string {
  return resolve(process.env.AGENT_SANDBOX_ROOT ?? process.cwd());
}

// 把用户给的路径归一成绝对路径,并校验落在沙箱根内;越界抛错。
// AGENT_SANDBOX=0 时跳过校验、直接返回归一后的绝对路径。
// 返回值同时用作 fs 操作路径 + readFiles 的键(保持一致)。
export function resolveInSandbox(userPath: string): string {
  const root = sandboxRoot();
  const abs = resolve(root, userPath);
  if (process.env.AGENT_SANDBOX === "0") return abs; // 沙箱关闭
  // 界内 = 恰好是根,或以「根 + 分隔符」开头(防 /work-evil 前缀误判)。
  if (abs === root || abs.startsWith(root + sep)) return abs;
  throw new Error(
    `路径超出工作目录沙箱：${abs}（根：${root}）——只能访问工作目录内的文件;` +
      `确需访问外部可设 AGENT_SANDBOX=0`,
  );
}
