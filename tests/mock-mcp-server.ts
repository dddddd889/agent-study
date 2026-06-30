// 极小的 mock MCP server(stdio):读「换行分隔的 JSON-RPC」,应答
// initialize / tools/list / tools/call。仅供测试 StdioTransport + McpClient。
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function reply(id: number, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function handle(msg: { id?: number; method: string; params?: any }) {
  switch (msg.method) {
    case "initialize":
      reply(msg.id!, {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "mock", version: "1.0" },
      });
      break;
    case "notifications/initialized":
      break; // 通知，无响应
    case "tools/list":
      reply(msg.id!, {
        tools: [
          {
            name: "echo",
            description: "回显文本",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
      break;
    case "tools/call":
      reply(msg.id!, {
        content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }],
        isError: false,
      });
      break;
  }
}
