import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPatchTool, parsePatch } from "../src/patch";

const dir = mkdtempSync(join(tmpdir(), "patch-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let readFiles: Set<string>;
beforeEach(() => {
  readFiles = new Set();
});
const ctx = () => ({ readFiles });

function seed(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  readFiles.add(resolve(p)); // 模拟「已 read」
  return p;
}
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("parsePatch 解析", () => {
  test("识别 update/add/delete 三类段", () => {
    const ops = parsePatch(
      wrap("*** Update File: a.ts\n-x\n+y\n*** Add File: b.ts\n+hi\n*** Delete File: c.ts"),
    );
    expect(ops.map((o) => o.type)).toEqual(["update", "add", "delete"]);
  });
  test("缺 Begin 报格式错误", () => {
    expect(() => parsePatch("*** Update File: a\n-x\n+y")).toThrow("补丁格式错误");
  });
});

describe("apply_patch 应用", () => {
  test("多 hunk 更新(内容定位,免疫行漂移)", async () => {
    const p = seed("m.ts", "a\nb\nc");
    // hunk1 在 a 后插一行 → 下面行号全变;hunk2 仍靠内容找到 c。
    await applyPatchTool.run(
      { patch: wrap(`*** Update File: ${p}\n@@\n a\n+INSERTED\n@@\n-c\n+C2`) },
      ctx(),
    );
    expect(readFileSync(p, "utf-8")).toBe("a\nINSERTED\nb\nC2");
  });

  test("新增文件(Add)", async () => {
    const p = join(dir, "added.ts");
    const out = String(await applyPatchTool.run({ patch: wrap(`*** Add File: ${p}\n+hello\n+world`) }, ctx()));
    expect(readFileSync(p, "utf-8")).toBe("hello\nworld");
    expect(out).toContain("Add");
  });

  test("删除文件(Delete)", async () => {
    const p = seed("del.ts", "bye");
    await applyPatchTool.run({ patch: wrap(`*** Delete File: ${p}`) }, ctx());
    expect(existsSync(p)).toBe(false);
  });

  test("多文件一个补丁", async () => {
    const a = seed("f1.ts", "old1");
    const b = seed("f2.ts", "old2");
    await applyPatchTool.run(
      { patch: wrap(`*** Update File: ${a}\n-old1\n+new1\n*** Update File: ${b}\n-old2\n+new2`) },
      ctx(),
    );
    expect(readFileSync(a, "utf-8")).toBe("new1");
    expect(readFileSync(b, "utf-8")).toBe("new2");
  });

  test("原子:后一个文件 hunk 失败 → 前一个也不写", async () => {
    const a = seed("atom1.ts", "old1");
    const b = seed("atom2.ts", "keep");
    await expect(
      applyPatchTool.run(
        { patch: wrap(`*** Update File: ${a}\n-old1\n+new1\n*** Update File: ${b}\n-NOPE\n+x`) },
        ctx(),
      ),
    ).rejects.toThrow("未命中");
    expect(readFileSync(a, "utf-8")).toBe("old1"); // 整补丁未应用,a 保持原样
    expect(readFileSync(b, "utf-8")).toBe("keep");
  });

  test("hunk 不唯一 → 原子失败", async () => {
    const p = seed("dup.ts", "x\nx");
    await expect(
      applyPatchTool.run({ patch: wrap(`*** Update File: ${p}\n-x\n+y`) }, ctx()),
    ).rejects.toThrow("不唯一");
    expect(readFileSync(p, "utf-8")).toBe("x\nx");
  });
});

describe("apply_patch 前置校验", () => {
  test("Update 未先 read → 报错且不写", async () => {
    const p = join(dir, "unread.ts");
    writeFileSync(p, "old", "utf-8"); // 注意:没加进 readFiles
    await expect(
      applyPatchTool.run({ patch: wrap(`*** Update File: ${p}\n-old\n+new`) }, ctx()),
    ).rejects.toThrow("必须先 read_file");
    expect(readFileSync(p, "utf-8")).toBe("old");
  });

  test("Add 目标已存在 → 报错(不覆盖)", async () => {
    const p = seed("exists.ts", "here");
    await expect(
      applyPatchTool.run({ patch: wrap(`*** Add File: ${p}\n+new`) }, ctx()),
    ).rejects.toThrow("已存在");
    expect(readFileSync(p, "utf-8")).toBe("here");
  });

  test("apply_patch 是 dangerous、非 concurrent", () => {
    expect(applyPatchTool.dangerous).toBe(true);
    expect(applyPatchTool.concurrent).toBeFalsy();
  });
});
