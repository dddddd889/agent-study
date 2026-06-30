# 第 10 步：安全控制(危险工具执行前人工确认)

> 到第 9 步,`shell` 能自动执行任意命令、`write_file` 能覆盖任意文件、`read_file` 能读 `.env`/密钥、`http_request` 能外发数据 —— 全程**无人把关**。这一步加一道**执行前人工确认(permission gate)**:危险工具跑之前先问你"允许吗"。

这是 agent 安全控制的**核心总闸**,装好后所有危险工具都受控。其余具体护栏(路径沙箱、http 超时/SSRF、shell 白名单)本轮留 TODO。

## 哪些算"危险"

原则:**碰文件系统 / 网络 / 进程的工具 = 危险(要确认);纯内存计算的 = 安全。**

| 工具 | dangerous | 风险 |
|---|---|---|
| `read_file` | ✅ | 机密性:能读密钥/隐私,且可经 http 外泄 |
| `write_file` | ✅ | 完整性:改/覆盖文件 |
| `http_request` | ✅ | 外发数据 / 打内网 |
| `shell` | ✅ | 执行任意命令,最危险 |
| `get_current_time` / `calculator` | ❌ | 纯计算,无副作用 |

> 注意:**读也危险**。安全三性里 `read` 破坏的是**机密性**("改世界才危险"的直觉漏了这点)—— 读到 `.env` 再 `http_request` 发出去就是经典的数据外泄链。在 [types.ts](../src/types.ts) 给 `Tool` 加了 `dangerous?: boolean`,在 [tools.ts](../src/tools.ts) 给这 4 个 IO 工具标上。

## 确认机制([src/agent.ts](../src/agent.ts))

工具循环里、`runTool` 之前插一道闸 `checkPermission(call)`:

- 非危险工具 / 本会话已选 `always` → 直接放行;
- 危险工具 → 调 `onApprove({ name, input })`,返回三选一:
  - **`once`** 允许这一次;
  - **`always`** 本会话内总是允许该工具(记到内存的 `alwaysAllowed` Set,后续同名工具不再弹问);
  - **`deny`** 拒绝 → **不执行**,把 `[用户拒绝执行 X]` 作为 `is_error` 的 `tool_result` **喂回模型**,对话继续(模型可换方式或解释),**不中断整轮**。
- **没配 `onApprove` → 默认拒绝(fail closed)**:危险工具一律不执行,返回 `[已拒绝：未配置人工确认]`。安全优先 —— 想用危险工具必须显式接入审批。

`onApprove` 是回调,Agent 不直接读输入,与 UI 解耦(沿用 `onToolCall` 那套风格)。

## CLI:从 for-await 重构成 ask()([src/cli.ts](../src/cli.ts))

审批弹问发生在 `agent.send` **执行中途**。原来的主循环 `for await (const line of rl)` 会和"中途再读一行 y/a/n"**抢同一份输入**。所以把主循环重构成显式的 `ask()`:

```ts
const ask = (q) => new Promise((resolve) => {
  const onClose = () => resolve(null);        // rl 关闭 → null(空闲 Ctrl+C 退出)
  rl.once("close", onClose);
  rl.question(q, (a) => { rl.off("close", onClose); resolve(a); });
});
```

这样同一时刻只有一个 `rl.question` 在等:主循环拿到行后进入处理,期间嵌套的审批 `rl.question` 是唯一未决的问题,不打架。审批读一行,取首字符:`y→once / a→always / 其它→deny`。回合中按 **Ctrl+C** → 审批 `resolve("deny")` + 中断本轮。

### 为什么只能"y/a/n + 回车"?

因为我们用 Node 的 **`readline`**(零依赖、行式)。**Claude Code 的那种单键/方向键模态**是用 **Ink(React for CLIs)+ raw 模式逐键监听**实现的,不是 readline。要那种体验得引入 Ink/blessed,会破坏"零依赖" → 单键模态留 TODO。

## 测试(`bun test`)

[tests/agent.test.ts](../tests/agent.test.ts) 用标了 `dangerous` 的假工具 + FakeLLM:

- `once` → 执行,`onApprove` 调 1 次;
- `deny` → 不执行,喂回 is_error,对话继续到 end_turn;
- `always` → 连续两轮危险工具,只在第一次弹问;
- **默认拒绝**:没配 `onApprove` → 危险工具不执行;
- 安全工具(无 `dangerous`)**不触发** `onApprove`。

> PTY 实测:模型请求 `shell echo …` → 弹"⚠ 允许执行 shell(…)? [y]/[a]/[n]" → 按 `n` → `[用户拒绝执行 shell]` 且对话继续;按 `y` → 命令执行、返回输出。

## 留下的 TODO

1. **路径沙箱**:`read_file`/`write_file` 限制在工作目录内,防 `../../etc/passwd`;
2. **http 超时 + SSRF 防护**;**shell 命令白名单**;
3. **单键/模态确认**(需 raw 模式或 Ink);
4. 更细的粒度:按 `input` 判断(如 http 只确认写操作)、审批策略持久化(跨会话记住 always)。

## 下一步

1. **摘要压缩**:上下文管理从"截断"升级为"先摘要再丢";
2. 多后端 LLM、子 agent / 规划等进阶。
