import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools";

process.env.AGENT_SANDBOX = "0"; // 本文件测工具行为,临时目录在 cwd 外 → 关沙箱(沙箱另见 sandbox.test.ts)
const dir = mkdtempSync(join(tmpdir(), "edit-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 每个用例给一份「已读集合」当 ctx,模拟某个 agent 的 readFiles。
let readFiles: Set<string>;
beforeEach(() => {
  readFiles = new Set();
});
const ctx = () => ({ readFiles });

function seed(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("read_file 分页 + 行号", () => {
  test("带行号输出;offset/limit 只取中间几行 + 续读提示", async () => {
    const path = seed("nums.txt", ["a", "b", "c", "d", "e"].join("\n"));
    readFiles.add(resolve(path)); // 无所谓,read 自己会加

    const head = await readFileTool.run({ path }, ctx());
    expect(head).toBe("1\ta\n2\tb\n3\tc\n4\td\n5\te");

    const mid = await readFileTool.run({ path, offset: 2, limit: 2 }, ctx());
    expect(mid).toContain("2\tb");
    expect(mid).toContain("3\tc");
    expect(mid).not.toContain("1\ta");
    expect(mid).toContain("继续用 offset=4"); // 还有更多 → 提示续读
  });

  test("read 成功会把文件记进 readFiles(供 read-before-edit)", async () => {
    const path = seed("r.txt", "x");
    await readFileTool.run({ path }, ctx());
    expect(readFiles.has(resolve(path))).toBe(true);
  });
});

describe("edit_file:精确字符串替换", () => {
  test("唯一命中 → 替换成功并写回", async () => {
    const path = seed("code.ts", "const a = 1;\nconst b = 2;\n");
    await readFileTool.run({ path }, ctx()); // 先读
    const out = await editFileTool.run(
      { path, old_string: "const a = 1;", new_string: "const a = 42;" },
      ctx(),
    );
    expect(out).toContain("替换 1 处");
    expect(readFileSync(path, "utf-8")).toBe("const a = 42;\nconst b = 2;\n");
  });

  test("0 命中 → 报错", async () => {
    const path = seed("z.ts", "hello");
    await readFileTool.run({ path }, ctx());
    await expect(
      editFileTool.run({ path, old_string: "nope", new_string: "x" }, ctx()),
    ).rejects.toThrow("0 次命中");
  });

  test("多命中且未 replace_all → 报错;replace_all → 全替", async () => {
    const path = seed("dup.ts", "x\nx\nx\n");
    await readFileTool.run({ path }, ctx());
    await expect(
      editFileTool.run({ path, old_string: "x", new_string: "y" }, ctx()),
    ).rejects.toThrow("不唯一");

    const out = await editFileTool.run(
      { path, old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(out).toContain("替换 3 处");
    expect(readFileSync(path, "utf-8")).toBe("y\ny\ny\n");
  });

  test("new_string 留空 = 删除那段", async () => {
    const path = seed("del.ts", "keep\nDROP\nkeep2\n");
    await readFileTool.run({ path }, ctx());
    await editFileTool.run({ path, old_string: "DROP\n", new_string: "" }, ctx());
    expect(readFileSync(path, "utf-8")).toBe("keep\nkeep2\n");
  });
});

describe("read-before-edit 守卫", () => {
  test("没 read 过 → edit 报错", async () => {
    const path = seed("guard.ts", "a = 1");
    // 没调 read_file
    await expect(
      editFileTool.run({ path, old_string: "a = 1", new_string: "a = 2" }, ctx()),
    ).rejects.toThrow("必须先 read_file");
  });

  test("write_file 也算已读 → 写后可直接 edit", async () => {
    const path = join(dir, "written.ts");
    await writeFileTool.run({ path, content: "a = 1" }, ctx());
    const out = await editFileTool.run(
      { path, old_string: "a = 1", new_string: "a = 2" },
      ctx(),
    );
    expect(out).toContain("替换 1 处");
  });
});
