import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveInSandbox, sandboxRoot } from "../src/sandbox";

// 本文件显式控制 env(不依赖默认),免受其它测试文件设 AGENT_SANDBOX=0 的串味。
const saved = { on: process.env.AGENT_SANDBOX, root: process.env.AGENT_SANDBOX_ROOT };
beforeEach(() => {
  process.env.AGENT_SANDBOX_ROOT = "/sbx/root"; // 固定根(词法判定,无需真实存在)
  delete process.env.AGENT_SANDBOX; // 默认开启
});
afterEach(() => {
  if (saved.on === undefined) delete process.env.AGENT_SANDBOX;
  else process.env.AGENT_SANDBOX = saved.on;
  if (saved.root === undefined) delete process.env.AGENT_SANDBOX_ROOT;
  else process.env.AGENT_SANDBOX_ROOT = saved.root;
});

describe("路径沙箱:resolveInSandbox", () => {
  test("界内相对路径 → 归一成根下绝对路径", () => {
    expect(resolveInSandbox("a/b.ts")).toBe("/sbx/root/a/b.ts");
    expect(resolveInSandbox(".")).toBe("/sbx/root"); // 根本身
    expect(resolveInSandbox("x/../y.ts")).toBe("/sbx/root/y.ts"); // 界内的 .. 归一后仍在界内
  });

  test("../ 穿越到根外 → 抛错", () => {
    expect(() => resolveInSandbox("../evil")).toThrow("超出工作目录沙箱");
    expect(() => resolveInSandbox("../../etc/passwd")).toThrow("超出");
  });

  test("绝对路径在根外 → 抛错", () => {
    expect(() => resolveInSandbox("/etc/passwd")).toThrow("超出");
  });

  test("前缀相同但不同目录(/sbx/root-evil)→ 抛错,不误判为界内", () => {
    expect(() => resolveInSandbox("../root-evil/x")).toThrow("超出");
  });

  test("AGENT_SANDBOX=0 关闭 → 根外路径也直接放行(返回绝对路径)", () => {
    process.env.AGENT_SANDBOX = "0";
    expect(resolveInSandbox("/etc/passwd")).toBe("/etc/passwd");
    expect(resolveInSandbox("../evil")).toBe("/sbx/evil"); // 不抛,只归一
  });

  test("AGENT_SANDBOX_ROOT 覆盖根", () => {
    process.env.AGENT_SANDBOX_ROOT = "/other/base";
    expect(sandboxRoot()).toBe("/other/base");
    expect(resolveInSandbox("f.ts")).toBe("/other/base/f.ts");
    expect(() => resolveInSandbox("/sbx/root/f.ts")).toThrow("超出"); // 原根现在也算界外
  });
});
