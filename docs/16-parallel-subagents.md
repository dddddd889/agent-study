# 第 16 步：并行子 agent（并发执行）

> 第 15 步能把子任务甩给隔离的子 agent，但一次只能派**一个**、串着跑。这一步让主 agent 在**一轮**里同时派出**多个**子 agent 并发执行——从「一个个来」变成「一群一起」。这是「多 agent」最本质的一格。

## 并行发生在哪：工具执行循环

模型本来就能在一个 assistant 轮里一次吐出**多个** `tool_use`。第 2 步以来，[src/agent.ts](../src/agent.ts) 的工具执行循环一直是**串行**的（一个个 `await`）。这一步把它改成可并发——但用**保守触发**，见 [ADR-0002](adr/0002-parallel-subagents-concurrent-tool-flag.md)。

## 核心设计：`concurrent` 标志 + 「全并发才并行」

给 `Tool` 加一个 `concurrent?` 标志（[src/types.ts](../src/types.ts)）。执行循环按这条规则分流：

```ts
// 本轮 >1 个调用【且全是 concurrent 工具】→ 并发;否则串行。
const allConcurrent =
  toolUses.length > 1 &&
  toolUses.every((c) => this.tools.find((t) => t.name === c.name)?.concurrent);
```

- `dispatch_agent` 标 `concurrent: true` → **一次派多个子 agent 会并行**。
- 只要混进任何非 `concurrent` 工具（`write_file` / `shell` 这类有副作用、讲顺序的）→ **整轮退回串行**，杜绝并发写文件 / 跑命令的竞态。

这样「并发」是 Agent 的一个**通用能力**（不硬编码 "dispatch_agent"，和 `dangerous`/`auxiliary` 一个路子），而「子 agent 可并行」只是它标了这个 flag 的自然结果。

## 五个要守住的不变量

把「单个工具调用的一趟」抽成 `execOne()`，串行/并行两条路都复用它，保证语义一致。并行路额外守住：

### 1. 并发上限（信号量）

一轮可能派几十个子 agent，全放开会打爆 API 速率 / 本机。用一个极简**异步信号量**限流，默认 5（`AGENT_MAX_CONCURRENCY`）：

```ts
const sem = new Semaphore(this.maxConcurrency);
await Promise.allSettled(toolUses.map((call, i) =>
  sem.run(() => this.execOne(call, signal)).then((r) => { slots[i] = r; }),
));
```

### 2. 失败隔离（`allSettled` 而非 `all`）

并发 5 个，其中 1 个抛错，**不能把其余 4 个也带崩**。用 `allSettled` 式收集：每个 `tool_use` 各自成/败。失败的那个由 `runTool` 转成 `is_error`，其余照常返回。（`Promise.all` 会「一个 reject 全 reject」，不能用。）

### 3. 结果按索引配对，不因完成先后错位

完成顺序是乱的（谁先跑完谁先好），但 `tool_result` 必须**按原 `tool_use` 顺序 / 靠 id** 填回。所以结果先落进**按索引的槽位** `slots[i]`，再顺序收集，绝不错位。

### 4. 中断：等所有在飞子 agent 封口后再收尾

Ctrl+C 时共享的 `signal` 传给所有在飞的子 agent，它们各自封口（补取消结果 + 落档）。`allSettled` 天然**等所有落定**；之后对「还没结算的槽位」`throwIfAborted()` → 交给既有的封口逻辑给未完成的 `tool_use` 补「[已被用户中断]」。延续「每个 tool_use 都有配对 result、历史合法」这条铁律。

### 5. 存档标识并发不撞（本步引入的 bug）

第 15 步用顺序号 `agent-N.jsonl`，而序号靠「数目录文件 +1」、档案又是子 agent **跑完**才写。**并行时多个子 agent 同时启动、都在任何人落盘前算出同号 → 撞车覆盖**。改用**随机短 id**（[src/subagent.ts](../src/subagent.ts) `allocSubagentId`，6 位十六进制）：天然唯一、并发分配也不撞，无需计数器/播种，档案名 `agent-<id>.jsonl`。短 id 还顺带成为显示上「同层区分 + 配色」的锚点（见下）。

> 中间一度用「进程内单调计数器」来保顺序号防撞；后来为了显示区分度（见下「输出交织」）直接改成随机短 id，计数器也随之去掉。

## 输出与审批：并行下的两处冲突

并行会同时打破第 15 步「实时缩进输出」和「逐个人工审批」，各自修：

- **输出交织** → 每行带**层级 + 身份**双重标记：**灰度块表层级**（`█` 主 agent、`▓` 子 agent、`▒` 孙、`░` 曾孙——密度随深度递减，未来放开嵌套也够用）＋**短 id 表身份**（`▓a2f9c1`）＋**给这个 `▓<id>` 标记上色**（正文保持默认色）。配色是**顺序分配**：每个新出现的子 agent 拿调色板里下一个颜色，保证同时出现的多个子 agent 颜色互不相同（超过调色板才回卷），同一 id 本会话内恒定同色；仅 TTY 上色、重定向输出纯文本。`console.log` 每次原子写整行不撕裂，交织时靠「颜色分同层的谁、灰度块分第几层」一眼分清。实时 / `/agents` / 磁盘档案三处 id 一致。
  - 当前不放开递归（[ADR-0001](adr/0001-subagent-as-context-isolated-tool.md)），所以只会渲染到 `▓`（子）；`▒`/`░` 是为将来嵌套预留的格式。
- **审批抢 stdin** → 给 `onApprove` 套一把**异步互斥锁**（[src/cli.ts](../src/cli.ts) `withApprovalLock`），并发的审批请求**排队、一次只弹一个**；顺带消除 `sessionAllowed` 的「查-问-加」竞态（第一个选了 `[a]总是`，轮到第二个时已在集合里、直接放行）。
- **审批提示被日志冲掉** → 互斥锁只保证「一次只弹一个」，但*其它*并行子 agent 仍在跑、仍会打日志，会把正在等你回答的提示行冲走。所以审批一旦挂起（`approvalPending`），其它工具/子 agent 的日志改走 `emit()` 先**缓冲**，等你答完再一次性 `flushHeld()` 放出来——提示行全程干净。

## 测试（`bun test`，离线）

[tests/parallel.test.ts](../tests/parallel.test.ts)：

- **并发上限**：一轮派 6 个 `concurrent` 工具、上限 2 → 观测到「同时在飞」峰值恰为 2；
- **串行回退**：两个 concurrent + 一个 plain 混在一轮 → 在飞恒为 1（退回串行）；
- **失败隔离**：并发 3 个、第 2 个抛错 → 整轮照常收敛，失败项 `is_error`、其余按 id 正确配对；
- **短 id 并发不撞**：并发派 3 个子 agent → 三个独立 `agent-<id>.jsonl`、id 互不相同、无覆盖。

## 边界与下一步

- **无嵌套并行**：子 agent 不能再派子 agent（[ADR-0001](adr/0001-subagent-as-context-isolated-tool.md)），并发只发生在主 agent 的一轮里。
- **B · 子 agent 类型/角色**：注册表 `{ [type]: { system, tools } }`，input 加 `agent_type`（Explore / Plan / critic）。
- **C · agent 间通信**：子 agent 之间传消息 / 共享黑板。
- 再往后：反思与验证闭环（critic 子 agent + verify 工具 + 返工循环）。
