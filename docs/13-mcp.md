# 第 13 步：接入 MCP(Model Context Protocol)

> 前面工具都是写死在本地的。这一步接入 **MCP** —— 连接外部 MCP server,把它们暴露的工具**拉过来适配成我们的 `Tool`**,塞进同一个工具循环。这样不写代码就能给 agent 加能力(文件系统、git、数据库…任何 MCP server)。

## MCP 是什么(够用版)

MCP 是 **JSON-RPC 2.0** 协议。客户端连上 server 后:

1. **握手**:`initialize` 请求 → server 回能力 → 客户端发 `notifications/initialized`;
2. `tools/list` → 拿到工具列表(每个含 `name / description / inputSchema`);
3. `tools/call` → 调用,返回 `content` 块(+ 可选 `isError`)。

传输两种,我们都做了(手写、零依赖):

- **stdio**:把 server 当**子进程**起,通过其 stdin/stdout 收发**换行分隔的 JSON**(本地 server 最常用);
- **HTTP**(Streamable HTTP 精简版):每次 **POST** 一条请求,读响应(JSON 或 SSE),用 `Mcp-Session-Id` 记会话。

## 架构([src/mcp.ts](../src/mcp.ts))

抽一个 **`Transport` 接口**(`start/send/onMessage/close`),`StdioTransport`(child_process)和 `HttpTransport`(fetch)各实现一份;上面跑共享的 **`McpClient`**(用 id↔Promise 关联请求/响应)。`loadMcpTools()` 读配置 → 连每个 server → `tools/list` → 适配成 `Tool[]`,返回 `{ tools, close, servers }`。

**手写而非用官方 SDK**:守住"零运行时依赖" —— stdio 用 `node:child_process`、HTTP 用原生 `fetch`。健壮性(重连、全 capability、流式 HTTP)列 TODO。

## 配置:`.mcp.json`

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"] },
    "myremote":   { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

- 有 `command` → stdio;有 `url` → HTTP。
- 默认读 `.mcp.json`(已 gitignore,可能含 token),`AGENT_MCP_CONFIG` 可覆盖路径。
- 没有该文件 → 不连 MCP,正常启动。

## 工具映射

| MCP | → 我们的 `Tool` |
|---|---|
| `name` | `<server>__<name>`(前缀防多 server 撞名) |
| `description` | 直搬 |
| `inputSchema`(本就是 JSON Schema) | 直搬到 `inputSchema` |
| `tools/call` 返回 | `run` 转发调用 → 抽 `content` 文本 → 截断(~10k);`isError` → 抛错(由 `runTool` 转 is_error) |
| —— | **`dangerous: true`**:外部工具统一走第10步人工确认 |

`Agent` **零改动** —— MCP 工具就是普通 `Tool`,CLI 把 `[...defaultTools, ...mcp.tools]` 传进去。

## 生命周期 + 可观测 + 热重载([src/cli.ts](../src/cli.ts))

- **启动**:`loadMcpTools()` 连接、合并工具、打印概况;**某个 server 起不来就跳过**(记 error),不影响其它和启动。
- **`/mcp`**:查看各 server 状态 + 暴露的工具(可观测)。
- **`/mcp reload`**:`close()` 关旧连接 → 重读 `.mcp.json` 重连 → **`agent.setTools([...defaultTools, ...mcp.tools])`** 运行时换工具集(改了配置/加了 server 不用重启)。这是本步唯一动 `Agent` 的地方(新增 `setTools`)。
- **退出**:`close()` kill 所有子进程 / 关会话。

```
mock (stdio) ✓  1 个工具: echo      ← 启动/​/mcp 概况
你 > 用 mock__echo 工具回显 hello-mcp
  · 调用工具 mock__echo({"text":"hello-mcp"})
  · mock__echo 结果：echo: hello-mcp
```

## 测试(`bun test`)

- [tests/mcp.test.ts](../tests/mcp.test.ts) + [tests/mock-mcp-server.ts](../tests/mock-mcp-server.ts):
  - **stdio 集成**:真起一个极小 mock MCP server 子进程,验证 `initialize → tools/list → 适配(前缀+dangerous)→ tools/call` 往返;
  - **坏 server**:命令不存在 → 跳过、记 error、不抛;
  - **HTTP**:mock `fetch` 验证 POST 发请求、JSON 响应、适配 + 调用。
- 端到端用 PTY 实测过(上面那段)。

## 留下的 TODO

1. **resources / prompts**(本步只做 tools);
2. HTTP 的**流式读 + 服务器推送**(GET SSE)、更完整的会话/重连;
3. 请求**超时**、stdio server 崩溃后**自动重连**;
4. 协议版本协商(目前固定 `2024-11-05`)。

## 下一步

1. RAG / 检索;子 agent 隔离;
2. A2A 等**多 agent 通信协议**(等有了多 agent 再谈)。
