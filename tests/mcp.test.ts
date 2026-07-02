import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpTools } from "../src/mcp";

const realFetch = globalThis.fetch;
const tmps: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AGENT_MCP_CONFIG;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 写一个临时 .mcp.json 并指向它。
function useConfig(mcpServers: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-mcp-"));
  tmps.push(dir);
  const f = join(dir, "mcp.json");
  writeFileSync(f, JSON.stringify({ mcpServers }), "utf-8");
  process.env.AGENT_MCP_CONFIG = f;
}

describe("MCP stdio(真起 mock server 子进程)", () => {
  test("连接 → tools/list → 适配 → tools/call 往返", async () => {
    useConfig({
      mock: { command: "bun", args: ["run", "tests/mock-mcp-server.ts"] },
    });

    const { tools, servers, close } = await loadMcpTools();

    expect(servers[0]!.ok).toBe(true);
    expect(servers[0]!.transport).toBe("stdio");

    // 适配:前缀 <server>__、归 exec 类(外部工具最保守,default 问/plan 拒)
    const echo = tools.find((t) => t.name === "mock__echo");
    expect(echo).toBeDefined();
    expect(echo!.category).toBe("exec");

    // 转发 tools/call
    const out = await echo!.run({ text: "hi" });
    expect(out).toBe("echo: hi");

    await close();
  });

  test("多 server 并行连接:墙钟≈最慢的一个,而非求和", async () => {
    // 两个各延迟 300ms 启动的 server。串行连 ≈600ms,并行 ≈300ms。
    const slow = {
      command: "bun",
      args: ["run", "tests/mock-mcp-server.ts"],
      env: { MOCK_DELAY_MS: "300" },
    };
    useConfig({ a: slow, b: slow });

    const t0 = Date.now();
    const { servers, close } = await loadMcpTools();
    const elapsed = Date.now() - t0;

    expect(servers.map((s) => s.name)).toEqual(["a", "b"]); // 排序稳定
    expect(servers.every((s) => s.ok)).toBe(true);
    expect(elapsed).toBeLessThan(550); // 并行:远小于串行的 ~600ms

    await close();
  });

  test("server 起不来 → 跳过、记 error,不抛", async () => {
    useConfig({ bad: { command: "this-command-does-not-exist-xyz", args: [] } });
    const { tools, servers, close } = await loadMcpTools();
    expect(servers[0]!.ok).toBe(false);
    expect(servers[0]!.error).toBeTruthy();
    expect(tools).toHaveLength(0);
    await close();
  });
});

describe("MCP HTTP(mock fetch)", () => {
  test("POST 发请求、JSON 响应,适配 + 调用", async () => {
    globalThis.fetch = (async (_url: any, init: any) => {
      const msg = JSON.parse(init.body);
      const json = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (msg.method === "initialize")
        return json({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: {} });
      if (msg.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (msg.method === "tools/list")
        return json({
          tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }],
        });
      if (msg.method === "tools/call")
        return json({ content: [{ type: "text", text: "pong" }] });
      return new Response("{}");
    }) as unknown as typeof fetch;

    useConfig({ remote: { url: "http://example.com/mcp" } });
    const { tools, servers, close } = await loadMcpTools();

    expect(servers[0]!.ok).toBe(true);
    expect(servers[0]!.transport).toBe("http");
    const ping = tools.find((t) => t.name === "remote__ping");
    expect(ping).toBeDefined();
    expect(await ping!.run({})).toBe("pong");

    await close();
  });
});
