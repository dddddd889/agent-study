import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  httpRequestTool,
  readFileTool,
  shellTool,
  writeFileTool,
} from "../src/tools";

describe("文件工具", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-study-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("write_file -> read_file 往返", async () => {
    const path = join(dir, "sub", "hello.txt"); // 父目录 sub 不存在，应自动创建
    const w = await writeFileTool.run({ path, content: "你好，工具" });
    expect(w).toContain(path);

    const r = await readFileTool.run({ path });
    expect(r).toBe("你好，工具");
  });

  test("read_file 读不存在的文件会抛错", async () => {
    await expect(
      readFileTool.run({ path: join(dir, "nope.txt") }),
    ).rejects.toThrow();
  });
});

describe("http_request 工具", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("透传 method/headers/body，并返回状态码 + 响应体", async () => {
    let captured: { url: string; init: any } = { url: "", init: {} };
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return new Response("pong", { status: 201 });
    }) as unknown as typeof fetch;

    const out = await httpRequestTool.run({
      url: "https://example.com/api",
      method: "POST",
      headers: { "x-test": "1" },
      body: "ping",
    });

    expect(captured.url).toBe("https://example.com/api");
    expect(captured.init.method).toBe("POST");
    expect(captured.init.headers).toEqual({ "x-test": "1" });
    expect(captured.init.body).toBe("ping");
    expect(out).toBe("HTTP 201\n\npong");
  });

  test("超长响应体会被截断", async () => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(20000), { status: 200 })) as unknown as typeof fetch;

    const out = await httpRequestTool.run({ url: "http://example.com" });
    expect(out).toContain("（已截断）");
    expect(out.length).toBeLessThan(20000);
  });

  test("非 http(s) 协议被拒绝", async () => {
    await expect(
      httpRequestTool.run({ url: "file:///etc/passwd" }),
    ).rejects.toThrow(/http\/https/);
  });

  test("把 ctx.signal 传给 fetch；signal 已 abort 时抛错", async () => {
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: any, init: any) => {
      seenSignal = init?.signal;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    ac.abort();
    await expect(
      httpRequestTool.run({ url: "http://example.com" }, { signal: ac.signal }),
    ).rejects.toThrow();
    expect(seenSignal).toBe(ac.signal); // 确实把 signal 传给了 fetch
  });
});

describe("shell 工具中断", () => {
  test("中途 abort 能快速 kill 子进程（不傻等命令结束）", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50); // 50ms 后中断
    const start = Date.now();
    await expect(
      shellTool.run({ command: "sleep 3" }, { signal: ac.signal }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1500); // 远快于 3s
  });
});

describe("shell 工具", () => {
  test("执行命令返回 stdout", async () => {
    const out = await shellTool.run({ command: "echo hi" });
    expect(out).toBe("hi");
  });

  test("非 0 退出会抛错", async () => {
    await expect(
      shellTool.run({ command: "exit 3" }),
    ).rejects.toThrow(/退出码 3/);
  });
});
