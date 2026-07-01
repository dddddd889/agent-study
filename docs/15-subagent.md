# 第 15 步：子 agent（上下文隔离，`dispatch_agent`）

> 第 14 步让 agent 会「把任务拆成清单」。但清单里所有步骤仍挤在**同一个上下文**里跑——步骤一多，中间过程（读了 10 个文件的正文、一堆 shell 输出）就把主上下文塞满，还得挤主 agent 的 `maxSteps` 预算。这一步给它一个能力：把一个**独立子任务**甩给一个**上下文隔离**的子 agent 去跑，主 agent 只**收回结论**。

## 核心洞察：子 agent 又是「一个普通 Tool」

和第 14 步一样反直觉又一致的一点：**子 agent 不需要改 `Agent` 类，它就是又一个 `Tool`。**

`dispatch_agent` 这个工具的 `run()` 内部 `new Agent(...)`、喂一段 prompt、跑完它**自己的**工具循环，把最终文本当 `tool_result` 返回。走的还是第 2 步那套工具循环——`Agent` 零改动。这与 `todo_write`、MCP 的接入哲学完全一致（核心不动、能力即工具），也正是 Claude Code `Task` 工具的做法。为什么选这条路而不是在 `Agent` 里做代码级编排，记在 [docs/adr/0001](adr/0001-subagent-as-context-isolated-tool.md)。

```
主 agent 循环
  └─ 调用工具 dispatch_agent({ prompt })
        └─ run(): new Agent(子 system, 子工具集, 独立预算)
              └─ 子 agent 循环:调模型→执行工具→喂回→…（十几步都在这里面）
              └─ 返回最终文本
        └─ tool_result = 结论（+ 一小段过程元信息）   ← 主上下文只多这一条
  └─ 主 agent 看到结论,继续作答
```

## 三个「隔离」＝ 这一步的全部价值

### 1. 上下文隔离

子 agent 启动时**只看到**「派活 `prompt` + 自身 system」，**看不到主对话历史**（[src/subagent.ts](../src/subagent.ts) 里 `new Agent` 不 `loadHistory`）。

- **好处**：子任务的所有中间过程（文件正文、shell 输出）留在子 agent 里，主上下文只多一条结论——省 token、主线清爽。
- **代价 / 要教的一课**：主 agent 必须把子任务所需的**全部背景写进 `prompt`**。不能说「像刚才那样」「用上面提到的文件」——子 agent 读不到。这是隔离模式最反直觉、最容易失败的点，所以工具描述和子 agent 的 system 里都**反复强调**了它。

### 2. 预算隔离

子 agent 有**自己**的 `maxSteps`（默认 25，`AGENT_SUBAGENT_MAX_STEPS` 可覆盖）和 `maxContextTokens`（默认 100000）。主 agent 花 **1 步**调 `dispatch_agent`，子 agent 内部却能跑满自己的预算——这正好化解了 [docs/14](14-planning-todo.md#L106) 结尾埋的那个问题：「任务本身的干活步数 > 主 agent 的 `maxSteps`」。子 agent 承接的往往是一整个子任务（读很多文件、多步 shell），所以它的默认预算比主 agent 宽。

**用尽预算时优雅收尾，而不是硬失败。** 若子 agent 撞满 `maxSteps`，`Agent.send()` 会抛「超过最大工具调用步数」。这时若直接把异常上抛，子 agent 前面十几步的工作就全丢了、主 agent 只收到一条干巴巴的错误。所以 `dispatch_agent` 捕获这个错，再做一次**不带工具**的「收尾」调用——让子 agent 基于已有历史给出**阶段性结论**，正常回传（`is_error: false`，附「⚠️达步数上限」提示），主 agent 拿到部分成果可以继续。只有连收尾都产不出文本，才真的当失败（`is_error`）上报。

### 3. 存档隔离

子 agent 的完整历史另存到主会话目录下的 `agents/` 子目录，**与主流水分开**：

```
.sessions/
  <主id>.jsonl              ← 主会话流水(只含 dispatch_agent 的调用 + 结论)
  <主id>/agents/
    agent-a2f9c1.jsonl      ← 某个子 agent 的完整过程(名字用它的随机短 id)
    agent-7b3e04.jsonl      ← 另一个子 agent …
```

> 注：第 15 步最初用顺序号 `agent-N.jsonl`,并行(第 16 步)后改成**随机短 id**,并发派活也不撞、还便于配色区分。见 [docs/16](16-parallel-subagents.md)。

- 档名用子 agent 的**随机短 id**（`agent-<id>.jsonl`，见 [src/subagent.ts](../src/subagent.ts) `allocSubagentId`）。并发派活天然不撞（第 16 步从顺序号改来，原因见 [docs/16](16-parallel-subagents.md)）。
- 落盘走子 agent 自己的 `onTurnComplete`——所以**被 Ctrl+C 中断时，封口后的部分档案也保存得下来**。
- `listSessions` 只认 `*.jsonl` 文件，`<主id>/` 目录被自动忽略，不污染会话列表。

## 边界：这一步刻意「不做」的

| 决策 | 结论 | 为什么 |
|---|---|---|
| 递归 | **禁**：子 agent 工具集 = 全套 − `dispatch_agent` 自己 | 杜绝无限递归 / fork 炸弹；只有主 agent 能派活 |
| 并发 | **串行**（沿用现有工具循环） | 并行会同时打破「实时缩进输出」与「逐个人工审批」（抢 stdout / 抢 stdin），需配套输出缓冲 + 审批排队，见下「下一步」 |
| 角色 | **单一通用**子 agent（input 只有 `{ prompt }`） | 一步只讲「隔离」一个概念；多类型注册表留作 TODO |
| 记忆 | 子 agent **不注入** `.memory.md` | 保持子 agent 干净;记忆是主会话层面的事 |

## 审批与中断：复用现成机制

- **审批透传**：子 agent 内的危险工具（shell 等）仍走主 agent 的**同一个** `onApprove`。而且主/子**共享**一个「本会话总是允许」集合（[src/cli.ts](../src/cli.ts) 的 `sessionAllowed`）——在主 agent 里对某工具选过 `[a]总是`，子 agent 再用它就不重复弹问。`dispatch_agent` 工具**自身非危险**（副作用都发生在子 agent 内部的具体工具上，那里才弹问）。
- **中断透传**：主 agent 的 `signal` 一路传进子 agent 的 `send()`。一次 Ctrl+C 同时中断两者：子 agent 先走它自己的**封口**逻辑（给未完成的 tool_use 补取消结果 + 落盘），然后 `dispatch_agent.run()` 感知到 abort → **上抛**（关键：不能 catch 成 `is_error`），交主 agent 的循环统一封口。这与既有 `runTool`「abort 就上抛」的约定一致。

## 返回给主 agent 的是什么

只有**结论**——子 agent 的最终文本，外加一小段过程元信息：

```
█ 派出子 agent ▓a2f9c1：去做子任务,背景齐全…
  ▓a2f9c1 调用 echo({"text":"hi"})
  ▓a2f9c1 echo 结果：echo:hi
█ dispatch_agent 结果：子任务完成:结论 X

（子 agent a2f9c1｜1 步｜用过工具: echo）
```

> 前缀说明(第 16 步)：`█` 主 agent、`▓<id>` 子 agent(短 id),子 agent 行还会**按 id 上色**;缩进/灰度块表层级。详见 [docs/16](16-parallel-subagents.md)。

子 agent 跑完**没有任何文本输出**（比如撞满步数）时，`run()` 抛错 → 主 agent 收到 `is_error` 的结果，知道子任务失败、可以改法重试，而不是静默拿到空结论。

## 引导模型去用它

和第 14 步一样，成败关键在提示词。两处都强调了「必须自带完整背景」：

1. **`dispatch_agent` 的工具描述**：讲清「何时用」（独立、边界清晰、中间过程多的子任务）+「⚠️ 子 agent 看不到当前对话，背景要写全」。
2. **主 agent 的 system 提示**（`baseSystem` 末段）加了一句引导。

## 可观测

- **实时**：子 agent 的每步工具调用/结果带 `  ▓<id> ` 前缀（灰度块表层级、短 id + 颜色表身份）打到终端，和主 agent（`█`）的输出层级分明——你能亲眼看着一个独立的子循环在跑。
- **事后**：`/agents` 命令列出本会话派出过的子 agent（短 id、消息数、prompt 摘要）；完整过程翻 `.sessions/<主id>/agents/agent-<id>.jsonl`。

## 测试（`bun test`，全程 `FakeLLM` 离线）

[tests/subagent.test.ts](../tests/subagent.test.ts)：用 `opts.system === SUBAGENT_SYSTEM` 区分「这次是主 agent 还是子 agent 的调用」来脚本化双方行为，临时目录接管存档。覆盖：

- **收回结论**：结论 + 元信息进主历史；子 agent 的 `echo` 调用**不**进主上下文；
- **上下文隔离**：子 agent 首次调用只看到 `prompt`，主对话文本不泄漏；
- **禁递归**：子 agent 工具集含子工具、不含 `dispatch_agent`；
- **存档**：`agents/agent-1.jsonl` 落盘含完整过程；两次派活 → `agent-2.jsonl` 递增；
- **失败语义**：子 agent 撞满步数 → 主 agent 收到 `is_error`。

## 下一步

- **并行子 agent**（已实现，见 [docs/16](16-parallel-subagents.md)）：主 agent 一轮派多个、并发跑，配套输出 `▓<id>` 灰度块 + 短 id + 配色，与审批互斥锁。
- **子 agent 类型/角色**：注册表 `{ [type]: { system, tools } }`，input 加 `agent_type`——像 Claude Code 的 Explore / Plan。
- **之后**才谈 agent 间的双向通信。
