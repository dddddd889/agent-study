import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  execSandboxEnv,
  wrapCommand,
  type ExecSandboxConfig,
  type SandboxEnv,
} from "../src/exec-sandbox";
import { shellTool } from "../src/tools";

// ============ 单元:纯函数(profile / argv,不 spawn)============
describe("执行沙箱:Seatbelt profile 生成", () => {
  test("写边界嵌入 root、默认禁网、含打底 allow default", () => {
    const p = buildSeatbeltProfile("/work/root", { net: false });
    expect(p).toContain('(subpath "/work/root")');
    expect(p).toContain("(allow default)");
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain("(deny network*)"); // 默认禁网
  });

  test("放网时不含 deny network*", () => {
    expect(buildSeatbeltProfile("/work/root", { net: true })).not.toContain(
      "(deny network*)",
    );
  });
});

describe("执行沙箱:bwrap 参数生成", () => {
  const cfg = (net: boolean): ExecSandboxConfig => ({
    enabled: true,
    net,
    root: "/work/root",
  });
  test("绑定 root 可写、整盘只读、默认 unshare-net", () => {
    const a = buildBwrapArgs(cfg(false));
    expect(a).toEqual(
      expect.arrayContaining(["--ro-bind", "--bind", "/work/root", "--unshare-net"]),
    );
  });
  test("放网时不 unshare-net", () => {
    expect(buildBwrapArgs(cfg(true))).not.toContain("--unshare-net");
  });
});

describe("执行沙箱:wrapCommand 拼 argv", () => {
  const cfg: ExecSandboxConfig = { enabled: true, net: false, root: "/work/root" };
  const mac: SandboxEnv = { platform: "darwin", hasSeatbelt: true, hasBwrap: false };
  const linux: SandboxEnv = { platform: "linux", hasSeatbelt: false, hasBwrap: true };

  test("关沙箱 → 裸跑 /bin/sh -c", () => {
    const { file, args } = wrapCommand("echo hi", { ...cfg, enabled: false }, mac);
    expect(file).toBe("/bin/sh");
    expect(args).toEqual(["-c", "echo hi"]);
  });

  test("darwin+seatbelt → sandbox-exec -p <profile> /bin/sh -c", () => {
    const { file, args } = wrapCommand("echo hi", cfg, mac);
    expect(file).toBe("sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain('(subpath "/work/root")'); // profile 里带 root
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  test("linux+bwrap → bwrap …args… /bin/sh -c", () => {
    const { file, args } = wrapCommand("echo hi", cfg, linux);
    expect(file).toBe("bwrap");
    expect(args).toContain("--unshare-net");
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  test("无可用沙箱 → fail-closed 抛错", () => {
    const none: SandboxEnv = { platform: "win32", hasSeatbelt: false, hasBwrap: false };
    expect(() => wrapCommand("echo hi", cfg, none)).toThrow("fail-closed");
    // darwin 但没 sandbox-exec 也拒
    expect(() =>
      wrapCommand("echo hi", cfg, { platform: "darwin", hasSeatbelt: false, hasBwrap: false }),
    ).toThrow("执行沙箱");
  });
});

// ============ 集成:真跑(仅 macOS + sandbox-exec;其它环境 skip)============
const CAN_INTEGRATE = process.platform === "darwin" && execSandboxEnv().hasSeatbelt;
const gate = CAN_INTEGRATE ? test : test.skip;

describe("执行沙箱:Seatbelt 真实施(darwin 门控)", () => {
  const root = mkdtempSync(join(tmpdir(), "exec-sbx-root-"));
  const outside = join(tmpdir(), `exec-sbx-outside-${process.pid}.txt`);
  const saved = {
    on: process.env.AGENT_SANDBOX_EXEC,
    root: process.env.AGENT_SANDBOX_ROOT,
    net: process.env.AGENT_SANDBOX_EXEC_NET,
  };

  beforeEach(() => {
    delete process.env.AGENT_SANDBOX_EXEC; // 开启执行沙箱(不被 tools.test 的 =0 串味)
    delete process.env.AGENT_SANDBOX_EXEC_NET; // 默认禁网
    process.env.AGENT_SANDBOX_ROOT = root; // 写边界 = 这个临时根
  });
  afterEach(() => {
    for (const [k, v] of [
      ["AGENT_SANDBOX_EXEC", saved.on],
      ["AGENT_SANDBOX_ROOT", saved.root],
      ["AGENT_SANDBOX_EXEC_NET", saved.net],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(outside, { force: true }); // 万一沙箱失效误建,兜底清掉
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  gate("写工作目录内 → 成功", async () => {
    const f = join(root, "inside.txt");
    await shellTool.run({ command: `echo hi > "${f}"` });
    expect(existsSync(f)).toBe(true);
  });

  gate("写工作目录外 → 被沙箱拒(命令失败、文件没建)", async () => {
    await expect(
      shellTool.run({ command: `echo hi > "${outside}"` }),
    ).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });
});
