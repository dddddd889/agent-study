# 第 3 步：常用内置工具（文件 / HTTP / Shell）

> 第 2 步（[工具调用循环](02-tool-calling-loop.md)）搭好了「模型请求工具 → 执行 → 喂回结果」的循环，但只有两个无副作用的玩具工具（时间、计算器）。
> 这一步给 agent 装上**真正能干活**的副作用工具：读写文件、发 HTTP 请求、执行 shell 命令。

这一步**不改 agent 循环**——循环在第 2 步已经通用。只是在 [src/tools.ts](../src/tools.ts) 里多注册四个 `Tool`，再加进 `defaultTools`，CLI 就能用了。这正是工具机制设计得当的体现：**加能力 = 加数据，不改控制流**。

## 设计原则：最简实现 + TODO 标护栏

这是学习项目，刻意「尽可能精简」：每个工具只做能跑通的核心逻辑，把生产环境才需要的**护栏**用 `// TODO` 标出来，既不喧宾夺主，又留下清晰的下一步学习路标。

## 四个新工具

> 📌 **后续改动**:本文描述的是第 3 步的初始实现。`http_request` / `shell` 等工具在后续步骤有增强 —— 工具内部支持中断(signal)见 [docs/07](07-interrupt.md);`http_request` 自动把 HTML 转成 Markdown 见 [docs/08](08-http-html-to-markdown.md)。下面的表格保留初始形态、不再逐一回改。

| 工具 | 入参 | 行为 | 关键取舍 |
|---|---|---|---|
| `read_file` | `{ path }` | 返回文件 UTF-8 文本 | 路径直接用；沙箱留 TODO |
| `write_file` | `{ path, content }` | 覆盖写，自动建父目录 | 单一覆盖语义（不支持 append）|
| `http_request` | `{ url, method?, headers?, body? }` | 原生 `fetch`，返回 `HTTP <状态>\n\n<体>` | 仅允许 http(s)；响应截断 |
| `shell` | `{ command }` | `child_process` 执行，返回 stdout+stderr | 30s 超时防卡死；非 0 退出转错误 |

几个共性细节：

- **输出截断**：工具结果统一截断到 ~10000 字符（`truncate()`）。网页/JSON/命令输出动辄几十 KB，不截断会瞬间吃光上下文 token——这是 agent 的实打实问题，所以**直接做、不留 TODO**。
- **错误即结果**：工具抛错由第 2 步的 Agent 循环捕获成 `is_error` 的 `tool_result` 喂回模型，让它看到错误自行纠正，而不是中断对话。所以工具内部「该抛就抛」即可。
- **跨运行时**：文件用 `node:fs/promises`、shell 用 `node:child_process`，Bun / Node 都能跑（与之前把 CLI 改成 node 兼容的方向一致）。

## 安全取舍（重要）

`shell` 是这套工具里最危险的——**模型可以让它执行任意命令**，且本步按约定**没有人工确认**（见下方 TODO）。当前配置下 `defaultTools` 包含 `shell`，CLI 里模型能自动执行命令。

- 这在**本地学习**场景是可接受的，也正是「看到 agent 真能干活」的乐趣所在。
- 如有顾虑，[src/cli.ts](../src/cli.ts) 里已注明：用 `defaultTools.filter(t => t.name !== "shell")` 即可摘掉 shell。

## 留下的 5 条 TODO（即「该加的护栏」）

1. `tools.ts` 顶部：工具变多后拆成 `src/tools/` 目录
2. `read_file` / `write_file`：路径沙箱，限制在工作目录内，防路径穿越/越权
3. `http_request`：超时（AbortController）、重定向策略、SSRF 防护
4. `shell`：沙箱 / 命令白名单 / 人工确认（生产环境必须）
5. agent 层：危险工具的 human-in-the-loop 审批机制

这些都是有意推迟的「下一步学习主题」，不是遗漏。

## 测试（`bun test`）

[tests/tools.test.ts](../tests/tools.test.ts) 覆盖核心路径：

- **文件**：临时目录里 `write_file → read_file` 往返（含自动建父目录）；读不存在文件抛错。
- **HTTP**：mock `globalThis.fetch`，断言 method/headers/body 透传 + 状态码格式 + 超长响应被截断 + 非 http(s) 被拒。
- **shell**：`echo hi` 冒烟 + 非 0 退出抛错。

```bash
bun test          # 23 个用例全部离线通过
bun run typecheck
```

## 下一步

1. **给危险工具加 human-in-the-loop 审批**（落实 TODO 5，本步最该补的护栏）
2. **流式输出（SSE）**：边生成边显示
3. **上下文管理**：token 计数、历史截断 / 摘要
4. **持久化**：把 `history` 存盘，跨进程续聊
