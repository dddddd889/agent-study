import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool, grepTool } from "../src/search";

// 造一个带噪音目录 + .gitignore 的临时工作区。
process.env.AGENT_SANDBOX = "0"; // 本文件测工具行为,临时目录在 cwd 外 → 关沙箱(沙箱另见 sandbox.test.ts)
const dir = mkdtempSync(join(tmpdir(), "search-test-"));
beforeAll(() => {
  mkdirSync(join(dir, "sub"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  mkdirSync(join(dir, "ignored"), { recursive: true });
  writeFileSync(join(dir, "a.ts"), "hello world\nfoo BAR\n");
  writeFileSync(join(dir, "b.js"), "hello js\n");
  writeFileSync(join(dir, "sub", "c.ts"), "deep hello\n");
  writeFileSync(join(dir, "node_modules", "x.ts"), "should skip");
  writeFileSync(join(dir, "ignored", "d.ts"), "should skip via gitignore");
  writeFileSync(join(dir, "e.log"), "should skip via *.log");
  writeFileSync(join(dir, "bin.dat"), "abc\x00hello\x00def"); // 含 null 字节 → 二进制
  writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("glob:按名找文件(只返回路径)", () => {
  test("**/*.ts 递归匹配,跳过 node_modules 与 .gitignore", async () => {
    const out = String(await globTool.run({ pattern: "**/*.ts", path: dir }));
    const paths = out.split("\n");
    expect(paths).toContain("a.ts");
    expect(paths).toContain("sub/c.ts");
    expect(out).not.toContain("node_modules"); // 基线跳过
    expect(out).not.toContain("ignored"); // .gitignore 跳过
  });

  test("*.ts 只匹配段内(不跨目录)", async () => {
    const out = String(await globTool.run({ pattern: "*.ts", path: dir }));
    expect(out.split("\n")).toContain("a.ts");
    expect(out).not.toContain("sub/c.ts");
  });

  test("无匹配给出提示", async () => {
    const out = String(await globTool.run({ pattern: "**/*.py", path: dir }));
    expect(out).toContain("无匹配");
  });

  test("glob 归 read 类(只读,各模式放行)", () => {
    expect(globTool.category).toBe("read");
  });
});

describe("grep:按正则搜内容", () => {
  test("命中输出 相对路径:行号:内容;跳过二进制与被忽略文件", async () => {
    const out = String(await grepTool.run({ pattern: "hello", path: dir }));
    expect(out).toContain("a.ts:1:hello world");
    expect(out).toContain("sub/c.ts:1:deep hello");
    expect(out).toContain("b.js:1:hello js");
    expect(out).not.toContain("bin.dat"); // 二进制跳过(即便含 hello)
    expect(out).not.toContain("node_modules");
  });

  test("glob 限定文件范围", async () => {
    const out = String(await grepTool.run({ pattern: "hello", path: dir, glob: "*.ts" }));
    expect(out).toContain("a.ts:1:hello world");
    expect(out).not.toContain("b.js"); // 被 *.ts 过滤掉
  });

  test("ignore_case", async () => {
    const noCase = String(await grepTool.run({ pattern: "bar", path: dir }));
    expect(noCase).toContain("无命中"); // 默认大小写敏感,BAR 不命中 bar
    const ci = String(await grepTool.run({ pattern: "bar", path: dir, ignore_case: true }));
    expect(ci).toContain("a.ts:2:foo BAR");
  });

  test("非法正则报错", async () => {
    await expect(grepTool.run({ pattern: "(", path: dir })).rejects.toThrow("非法正则");
  });

  test("grep 归 read 类(只读检索,与 read_file 同待遇,各模式放行)", () => {
    expect(grepTool.category).toBe("read");
  });
});
