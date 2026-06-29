# 第 7 步：中断回复(Ctrl+C 打断本轮)

> 使用中发现:agent 一旦开始回复,就只能干等它说完。这一步加上**随时中断**:回复中按 `Ctrl+C` 立刻停下、回到提示符,体验友好很多。

## 触发:Ctrl+C 的双重语义

- **回合进行中**按 `Ctrl+C` → **中断本轮**(停止流式 + 工具循环),回到提示符;
- **空闲在提示符**按 `Ctrl+C` → **退出程序**。

这是终端里最通用的"停下"语义(Claude Code、ipython、各种 REPL 都这样)。

## 机制:AbortSignal 贯穿全链路

用 Web 标准的 `AbortController` / `AbortSignal`(`fetch` 原生支持),一个 signal 串起整条链:

```
CLI(每轮 new AbortController)
  └─ agent.send(text, { signal })
       └─ llm.stream(messages, { signal })
            └─ fetch(url, { signal })   ← abort 后 HTTP/SSE 流立即断开
```

`CompleteOptions` 和 `Agent.send` 各加一个可选 `signal?: AbortSignal`。

## 中断能"穿透"到哪层

| 中断发生时 | 行为 | 响应 |
|---|---|---|
| **流式生成中** | `fetch` 收到 signal 立即断开,SSE 读取循环抛出 | 立即 |
| **工具循环边界** | 每次调 `stream` 前、每个工具执行前用 `signal.throwIfAborted()` 检查 | 立即(在边界) |
| **某个工具执行中** | signal 传进工具内部,会阻塞的工具(http/shell/读写)立即停 | 立即 |

三层都已打通(第三层见下方「工具内部中断」)。

## 关键:中断后整轮回滚([src/agent.ts](../src/agent.ts))

> ⚠️ **后续修订**:为了让被中断的对话也能持久化/恢复,第 9 步把这里的"整轮回滚"改成了**"封口成合法状态再保留"**(流式留半截文本、工具补 `is_error` 取消结果)。下面这段是本步的初始设计,封口方案见 [docs/09](09-persistence.md#中断的轮也能恢复封口修订第-7-步)。

中断可能发生在任意时刻 —— 甚至 assistant 已带 `tool_use`、但 `tool_result` 还没产生。若留下"带 tool_use 却无对应 tool_result"的残缺历史,**下一轮请求会被 API 直接 400**(孤儿 tool_use,和截断那个坑同源)。

所以中断时**整轮回滚**:把这一轮新增的所有消息(用户输入 + 半截 assistant + 半截 tool 结果)全部删掉,历史恢复到发送前。永远合法,不留孤儿。

```ts
const userMsg = { role: "user", content: userInput };
this.history.push(userMsg);
try {
  // ...循环;关键点 signal?.throwIfAborted();stream 也带 signal
} catch (err) {
  if (signal?.aborted) {
    const i = this.history.indexOf(userMsg); // 按引用定位，而非下标
    if (i >= 0) this.history.length = i;     // 砍掉本轮新增
  }
  throw err;
}
```

> **为什么用 `indexOf(userMsg)` 而不是记一个下标**:回合中 `compactHistory()` 可能截掉更早的轮,令下标偏移。按对象引用重新定位才稳。(compactHistory 始终保留最近一轮,所以当前这条 userMsg 一定还在。)

## 工具内部中断([src/types.ts](../src/types.ts) / [src/tools.ts](../src/tools.ts))

光在循环边界检查还不够 —— 如果中断时正卡在某个慢工具里(`http_request` 等响应、`shell` 跑长命令),边界要等工具自己结束才轮到。所以把 signal 一路传进工具:

- `Tool.run` 签名加一个上下文参数:`run(input, ctx?: { signal })`(用对象包装,方便以后扩展)。
- 各 IO 工具内部接上:
  - `http_request` → `fetch(url, { signal })`,Ctrl+C 立即断开请求;
  - `shell` → `exec(cmd, { timeout, signal })`,abort 时 kill 子进程;
  - `read_file` / `write_file` → `fs/promises` 的 `{ signal }`。
- 同步的 `get_current_time` / `calculator` 瞬时返回,无需接。

**`runTool` 的错误分流**(关键):工具因"用户中断"抛错,不该喂回模型,而该触发回滚:

```ts
try {
  const out = await tool.run(call.input, { signal });
  return { content: String(out), isError: false };
} catch (err) {
  if (signal?.aborted) throw err;                 // 用户中断 → 上抛 → send 回滚
  return { content: (err as Error).message, isError: true }; // 其它错误 → 喂回模型纠正
}
```

这样:`shell` 跑 `sleep 20` 时按 Ctrl+C,子进程立即被 kill、整轮回滚;而工具自身的失败(参数错、命令非 0 退出、网络错)仍照常喂回模型让它纠正。

## abort 不能被当成"网络抖动"重试([src/llm.ts](../src/llm.ts))

第 5 步的重试会把网络异常当作可重试。但被 abort 的 `fetch` 也抛"网络类"错误 —— 如果照样重试,中断就失效了。所以 `fetchWithRetry` 里:**只要 `signal.aborted`,立刻抛出、不重试**。

## CLI 怎么捕获 Ctrl+C([src/cli.ts](../src/cli.ts))

```ts
let currentAbort: AbortController | null = null;
rl.on("SIGINT", () => {
  if (currentAbort) currentAbort.abort(); // 回合中 → 中断本轮
  else rl.close();                        // 空闲 → 退出
});
```

### 一个绕不开的取舍:`rl.pause()` vs 捕获 Ctrl+C

第 6 步为了"AI 回复时防止用户抢输入造成回显交错",在回合期间 `rl.pause()`。但 **`rl.pause()` 会停止读取 stdin → 原始模式下连 Ctrl+C 的按键(`\x03`)也读不到** → 回合中按 Ctrl+C 不生效。两者不能兼得。

这步选择**去掉 `rl.pause()`**,换取"随时可中断"。代价:用户在 AI 流式回复时若打字,字符会回显、和流式输出交错(轻微观感);但"能随时停下"这个体验更重要。

## 测试(`bun test`)

- [tests/agent.test.ts](../tests/agent.test.ts):① 传**已 abort** 的 signal → `send` 抛错且**整轮回滚**;② **工具执行中**中断(用一个挂起到 abort 才 reject 的假工具)→ 上抛 + 整轮回滚。
- [tests/llm.test.ts](../tests/llm.test.ts):已 abort 的 signal → `stream` 抛错且 **fetch 只调一次**(验证 abort 不被当网络抖动重试)。
- [tests/tools.test.ts](../tests/tools.test.ts):`http_request` 把 signal 传给 `fetch`、abort 即抛错;`shell` 跑 `sleep` 时中途 abort → 毫秒级 kill 返回。

> 交互式中断需要真终端,已用 PTY 脚本验证两处:① 流式中按 Ctrl+C → 立即停 `(已中断)`;② **`shell` 跑 `sleep 20` 时按 Ctrl+C → 子进程立即被 kill**(没傻等 20s);两种情况之后都能正常继续对话(历史回滚干净)。

## 留下的 TODO

1. **`http_request` 超时**:用 `AbortSignal.timeout(ms)` + `AbortSignal.any([signal, timeout])` 合并"用户中断"和"超时"(这次只接了用户中断,没做超时)。
2. 也可考虑「双击 Ctrl+C 强制退出」等更细的快捷键语义。

## 下一步

1. **持久化**:把 `history` 存盘,跨进程续聊
2. **摘要压缩**:上下文管理从"截断"升级为"先摘要再丢"
