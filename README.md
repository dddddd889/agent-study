# agent-study · 第 1 步：最简对话循环

> 📈 **本仓库按步骤演进。** 当前代码已实现到 **第 18 步：子 agent 角色注册表**。步骤文档：
>
> - 第 2 步 · 工具调用循环 → [docs/02-tool-calling-loop.md](docs/02-tool-calling-loop.md)
> - 第 3 步 · 常用内置工具（文件 / HTTP / Shell）→ [docs/03-builtin-tools.md](docs/03-builtin-tools.md)
> - 第 4 步 · 上下文管理（token 估算 + 整轮截断）→ [docs/04-context-management.md](docs/04-context-management.md)
> - 第 5 步 · 请求重试 + 指数退避（LLM 层健壮性）→ [docs/05-retry-backoff.md](docs/05-retry-backoff.md)
> - 第 6 步 · 流式输出（SSE，边生成边显示）→ [docs/06-streaming.md](docs/06-streaming.md)
> - 第 7 步 · 中断回复（Ctrl+C 打断本轮，含工具内部）→ [docs/07-interrupt.md](docs/07-interrupt.md)
> - 第 8 步 · http_request 把 HTML 转成 Markdown → [docs/08-http-html-to-markdown.md](docs/08-http-html-to-markdown.md)
> - 第 9 步 · 持久化（JSONL 存盘 + 跨进程续聊）→ [docs/09-persistence.md](docs/09-persistence.md)
> - 第 10 步 · 安全控制（危险工具执行前人工确认）→ [docs/10-security-approval.md](docs/10-security-approval.md)
> - 第 11 步 · 摘要压缩 + 上下文可观测（/context）→ [docs/11-summarization-compaction.md](docs/11-summarization-compaction.md)
> - 第 12 步 · 跨会话长期记忆（记忆 agent + /memory）→ [docs/12-long-term-memory.md](docs/12-long-term-memory.md)
> - 第 13 步 · 接入 MCP（外部工具 / .mcp.json / /mcp [reload]）→ [docs/13-mcp.md](docs/13-mcp.md)
> - 第 14 步 · 规划 / 子任务分解（todo 清单 / todo_write / /todo）→ [docs/14-planning-todo.md](docs/14-planning-todo.md)
> - 第 15 步 · 子 agent（上下文隔离 / dispatch_agent / /agents）→ [docs/15-subagent.md](docs/15-subagent.md)
> - 第 16 步 · 并行子 agent（concurrent 工具 / 信号量 / 灰度块+短id+配色）→ [docs/16-parallel-subagents.md](docs/16-parallel-subagents.md)
> - 第 17 步 · 反思与验证闭环（critic 审查者 / 结构化裁定 / 返工循环）→ [docs/17-reflection-verify.md](docs/17-reflection-verify.md)
> - 第 18 步 · 子 agent 角色注册表（agent_type / general·explore·plan·critic / 禁嵌套基线）→ [docs/18-subagent-roles.md](docs/18-subagent-roles.md)
>
> 本文件介绍的是**第 1 步内核**（最简对话循环）——它仍是理解后续步骤的基础。

从最简单的 agent 循环出发，逐步构建完善的 agent 服务。这一步只做一件事：**一个能记住上下文的多轮对话 agent**。后续再往上叠加工具调用、规划、记忆等能力。

技术栈：**Bun + TypeScript**，零运行时依赖（直接用原生 `fetch`）。

## 什么是 agent 循环

一个 agent 的最小内核，就是一个循环：

```
读取输入 -> 调用 LLM -> 得到输出 -> 把输出追加进历史 -> 等待下一次输入
```

"记忆" 不是什么黑魔法：每一轮都把完整的对话历史重新发给 LLM，模型就能"看到"之前说过的话。本步骤实现的就是这个内核。

```
┌─────────────────────────────────────────────┐
│  history = [ ...之前所有 user/assistant 消息 ] │
└─────────────────────────────────────────────┘
        │ 1. push 用户新输入
        ▼
   history += {role:"user", content: 输入}
        │ 2. 把整段 history 发给 LLM
        ▼
   reply = LLM.complete(history)
        │ 3. push 助手回复
        ▼
   history += {role:"assistant", content: reply}
        │ 4. 返回 reply，等下一轮
        ▼
      （回到顶部）
```

## 代码结构

```
agent-study/
├── src/
│   ├── types.ts   # Message 类型 + LLM 接口（抽象，便于替换/测试）
│   ├── llm.ts     # AnthropicLLM：用 fetch 调 Messages API
│   ├── agent.ts   # Agent 类：维护历史，实现一轮 send()
│   └── cli.ts     # 命令行 REPL 入口
├── tests/
│   ├── fake-llm.ts     # 假 LLM，离线测试用
│   ├── agent.test.ts   # 对话循环 / 历史累积 测试
│   └── llm.test.ts     # 请求构造 / 鉴权 测试（mock fetch）
├── .env.example
└── package.json
```

三个关键抽象：

1. **`LLM` 接口**（types.ts）——`complete(messages, system?) => Promise<string>`。Agent 只依赖这个接口，不关心背后是 Anthropic 还是别的厂商，也方便测试时换成假实现。
2. **`Agent` 类**（agent.ts）——持有 `history` 数组，`send()` 就是上图的一轮循环。
3. **`AnthropicLLM`**（llm.ts）——`LLM` 的一个具体实现。

`Agent.send()` 全部逻辑只有几行：

```ts
async send(userInput: string): Promise<string> {
  this.history.push({ role: "user", content: userInput });
  const reply = await this.llm.complete(this.history, this.system);
  this.history.push({ role: "assistant", content: reply });
  return reply;
}
```

## 准备环境

安装 Bun（若未安装）：

```bash
curl -fsSL https://bun.sh/install | bash
```

安装依赖（仅类型定义）：

```bash
bun install
```

配置鉴权，支持两种方式，任选其一：

- **代理网关**：设置 `ECHO_TECH_ANTHROPIC_BASE_URL` 和 `ECHO_TECH_ANTHROPIC_AUTH_TOKEN`（走 `Authorization: Bearer`）。
- **官方 API**：设置 `ANTHROPIC_API_KEY`（走 `x-api-key`）。

可以写进 `.env`（参考 `.env.example`），Bun 会自动加载。如果这两个环境变量已经在你的 shell 里，直接运行即可。

## 运行

```bash
bun run start
```

进入 REPL 后：

```
你 > 你好，我叫小明
AI > 你好小明！很高兴认识你。
你 > 我叫什么名字？
AI > 你叫小明。      ← 证明它记住了上下文
```

命令：`/exit` 退出 · `/reset` 清空对话历史 · `/sessions` 列出会话 · `/new` 开新会话 · `/context` 看上下文用量 · `/memory` 看长期记忆 · `/todo` 看当前任务清单 · `/agents` 看本会话派出的子 agent · `/mcp [reload]` 看/重载 MCP。

续聊历史会话：`bun run src/cli.ts <sessionId>`（会话存在 `.sessions/`，惰性创建，跑完一轮才出现）。

危险工具（shell/读写文件/HTTP）默认执行前会**人工确认**；无人值守想全放行用 `AGENT_ALLOW_ALL=1 bun run start`（⚠ 慎用，详见 [docs/10](docs/10-security-approval.md)）。

## 调试：先跑测试

测试**完全离线**，不需要 API key，是 debug 的最佳起点：

```bash
bun test
```

测试用 `FakeLLM` 替换真实模型，验证 agent 循环的核心行为：

- 单轮能拿到回复；
- 多轮历史正确累积（user/assistant 交替）；
- 第二轮调用时，LLM 确实收到了前面的完整历史（这是"记忆"的关键）；
- `system` 提示正确透传；
- `reset()` / `getHistory()` 行为正确。

`tests/llm.test.ts` 则用 mock 过的 `fetch` 验证请求构造：URL 拼接、Bearer / x-api-key 两种鉴权切换、错误响应抛错。改了 `llm.ts` 后跑它就能确认请求没发错。

类型检查：

```bash
bun run typecheck
```

### 在 VSCode 里打断点调试

已附带 `.vscode/` 配置。一次性准备：

1. 安装扩展 **Bun for Visual Studio Code**（`oven.bun-vscode`）——打开项目时 VSCode 会自动提示安装。
2. 把 `.env.example` 复制为 `.env` 并填好鉴权（调试配置通过 `envFile` 读取它）。

然后在代码行号左侧点出红点设断点，按 `F5`，从顶部下拉选一个配置：

- **Debug: CLI 对话**——启动 REPL，在 `agent.ts` / `llm.ts` 里断点，单步看 `history` 怎么累积、请求怎么发出。
- **Debug: 当前测试文件**——调试编辑器里正打开的那个 `*.test.ts`（离线，最适合 debug）。
- **Debug: 全部测试**——跑 `bun test` 并在断点处停下。

调试时用 **变量(Variables)** 面板看 `this.history`、用 **调试控制台(Debug Console)** 直接求值，比 `console.log` 高效。

### 想看真实请求长什么样

在 `src/llm.ts` 的 `fetch` 前后加日志即可：

```ts
console.log("REQUEST", JSON.stringify(messages, null, 2));
// ... fetch ...
console.log("RESPONSE", data);
```

或者写个小脚本直接调 Agent，单步观察 `getHistory()` 的变化。

## 演进进度 & 下一步

从第 1 步内核出发，已经一步步长到了第 18 步。**已完成**（每步一篇 docs，见顶部导航）：

- ✅ 第 2 步 · 工具调用循环（从"聊天机器人"变"agent"的关键一步）
- ✅ 第 3 步 · 内置工具（文件 / HTTP / Shell）
- ✅ 第 4 步 · 上下文管理（token 估算 + 整轮截断）
- ✅ 第 5 步 · 请求重试 + 指数退避
- ✅ 第 6 步 · 流式输出（SSE）
- ✅ 第 7 步 · 中断回复（Ctrl+C 打断本轮）
- ✅ 第 8 步 · http_request 把 HTML 转 Markdown
- ✅ 第 9 步 · 持久化（JSONL 存盘 + 跨进程续聊）
- ✅ 第 10 步 · 安全控制（危险工具人工确认）
- ✅ 第 11 步 · 摘要压缩 + 上下文可观测（/context）
- ✅ 第 12 步 · 跨会话长期记忆（记忆 agent + /memory）
- ✅ 第 13 步 · 接入 MCP（外部工具 / .mcp.json / /mcp [reload]，后台并发启动）
- ✅ 第 14 步 · 规划 / 子任务分解（todo_write 工具 + /todo，规划能力来自"工具 + 提示"而非编排）
- ✅ 第 15 步 · 子 agent 隔离（dispatch_agent 工具 + /agents，上下文/预算/存档三重隔离，子 agent 仍是"一个普通工具"）
- ✅ 第 16 步 · 并行子 agent（concurrent 工具标志 + 异步信号量限流 + allSettled 失败隔离 + 灰度块/短id/配色输出 + 审批互斥锁）
- ✅ 第 17 步 · 反思与验证闭环（critic 审查者：grounded 隔离审查 + 结构化裁定 + 只为[严重]返工的循环，与 dispatch_agent 共用 runSubagent）
- ✅ 第 18 步 · 子 agent 角色注册表（src/roles.ts：general/explore/plan/critic，dispatch_agent 加 agent_type，配置集中·暴露分两种·禁嵌套基线）

**下一步（规划中）**：

- 🚧 **用户自定义角色**：从 `.claude/agents/*.md` 之类项目配置加载角色（对标 Claude Code），不改代码就能加。
- 🚧 **agent 间通信**：子 agent 之间传消息 / 共享黑板。
- 也可补基建：多行输入、消息级压缩、工具护栏（路径沙箱/SSRF）、prompt caching。

每一步都建议先补测试，再写实现——`FakeLLM` 的模式可以一直复用。
