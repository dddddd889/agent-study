import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Tool } from "./types";

// ===== MCP 客户端(手写、零依赖)=====
// MCP = JSON-RPC 2.0。客户端连 server:initialize 握手 → tools/list → tools/call。
// 两种传输:stdio(把 server 当子进程,按行收发 JSON)/ HTTP(POST 发,响应 JSON 或 SSE)。
// 范围:只做 tools。resources/prompts、HTTP 的服务器推送(GET SSE)、重连等留 TODO。

const MAX_OUTPUT = 10000;
function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…（已截断）" : s;
}

// ---- 传输抽象:收发 JSON-RPC 消息 ----
interface Transport {
  start(): Promise<void>;
  send(msg: object): Promise<void>;
  onMessage(cb: (msg: any) => void): void;
  close(): Promise<void>;
}

// stdio:子进程,按「换行分隔的 JSON」收发(MCP stdio 约定)。
class StdioTransport implements Transport {
  private child?: ChildProcess;
  private handler: (msg: any) => void = () => {};
  private buffer = "";
  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "ignore"], // server 的日志走 stderr,忽略
      env: { ...process.env, ...this.env },
    });
    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          try {
            this.handler(JSON.parse(line));
          } catch {
            // 非 JSON 行(偶发日志)忽略
          }
        }
      }
    });
    // 起不来(命令不存在等)→ 抛错,交给 loadMcpTools 跳过该 server
    await new Promise<void>((resolve, reject) => {
      this.child!.once("spawn", resolve);
      this.child!.once("error", reject);
    });
  }
  async send(msg: object): Promise<void> {
    this.child!.stdin!.write(JSON.stringify(msg) + "\n");
  }
  onMessage(cb: (msg: any) => void): void {
    this.handler = cb;
  }
  async close(): Promise<void> {
    this.child?.kill();
  }
}

// HTTP(Streamable HTTP 精简版):每次 POST 一条请求,读取响应(JSON 或 SSE)分发。
// 精简点:整段读响应(不流式)、不开 GET 长连接收服务器推送 —— 对"只做 tools"够用。
class HttpTransport implements Transport {
  private handler: (msg: any) => void = () => {};
  private sessionId?: string;
  constructor(
    private url: string,
    private headers?: Record<string, string>,
  ) {}

  async start(): Promise<void> {}

  async send(msg: object): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid; // initialize 后记住会话 id
    if (res.status === 202) return; // 通知:无响应体

    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ct.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            this.handler(JSON.parse(line.slice(5).trim()));
          } catch {}
        }
      }
    } else if (text.trim()) {
      try {
        this.handler(JSON.parse(text));
      } catch {}
    }
  }
  onMessage(cb: (msg: any) => void): void {
    this.handler = cb;
  }
  async close(): Promise<void> {}
}

// ---- JSON-RPC 客户端:在 Transport 之上做 请求/响应 关联 ----
class McpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  constructor(private transport: Transport) {
    transport.onMessage((msg) => {
      if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP 错误"));
        else p.resolve(msg.result);
      }
      // 服务器通知(无 id / 未知 id)忽略
    });
  }

  private request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-study", version: "0.1.0" },
    });
    // 握手收尾:通知(无需响应)
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: any }>
  > {
    const r = await this.request("tools/list");
    return r?.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content?: any[]; isError?: boolean }> {
    return await this.request("tools/call", { name, arguments: args });
  }
}

// ---- 配置 + 入口 ----
interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  ok: boolean;
  toolNames: string[];
  error?: string;
}

// 读 .mcp.json 的 mcpServers;可用 AGENT_MCP_CONFIG 覆盖路径(测试隔离)。
function loadConfig(): Record<string, McpServerConfig> {
  const f = process.env.AGENT_MCP_CONFIG ?? ".mcp.json";
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf-8")).mcpServers ?? {};
  } catch {
    return {};
  }
}

// 把一个 MCP 工具适配成我们的 Tool:前缀防撞名、schema 直搬、run 转发 tools/call。
function adapt(
  server: string,
  t: { name: string; description?: string; inputSchema?: any },
  client: McpClient,
): Tool {
  return {
    name: `${server}__${t.name}`,
    description: t.description ?? "",
    dangerous: true, // 外部工具,统一走人工确认
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    run: async (input) => {
      const res = await client.callTool(t.name, input);
      const text = (res.content ?? [])
        .map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
      if (res.isError) throw new Error(text || "MCP 工具返回错误"); // → runTool 转 is_error
      return truncate(text);
    },
  };
}

// 连接 .mcp.json 里的所有 server,适配工具。
// 返回:合并用的 tools、关闭函数、各 server 概况(给 /mcp 观测)。
// 某个 server 起不来 → 跳过(记 error),不影响其它和正常启动。
export async function loadMcpTools(): Promise<{
  tools: Tool[];
  close: () => Promise<void>;
  servers: McpServerInfo[];
}> {
  const cfg = loadConfig();
  const tools: Tool[] = [];
  const closers: Array<() => Promise<void>> = [];
  const servers: McpServerInfo[] = [];

  for (const [name, sc] of Object.entries(cfg)) {
    const kind: "stdio" | "http" = sc.url ? "http" : "stdio";
    const transport: Transport = sc.url
      ? new HttpTransport(sc.url, sc.headers)
      : new StdioTransport(sc.command ?? "", sc.args ?? [], sc.env);
    try {
      await transport.start();
      const client = new McpClient(transport);
      await client.initialize();
      const list = await client.listTools();
      for (const t of list) tools.push(adapt(name, t, client));
      closers.push(() => transport.close());
      servers.push({ name, transport: kind, ok: true, toolNames: list.map((t) => t.name) });
    } catch (e) {
      await transport.close().catch(() => {});
      servers.push({
        name,
        transport: kind,
        ok: false,
        toolNames: [],
        error: (e as Error).message,
      });
    }
  }

  return {
    tools,
    close: async () => {
      for (const c of closers) await c().catch(() => {});
    },
    servers,
  };
}
