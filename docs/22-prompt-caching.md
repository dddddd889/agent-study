# 第 22 步：提示词缓存（prompt caching）

> 前 21 步每一轮都把 system + 工具说明书 + 全部历史**全额重发、重算**。这一步接入 Anthropic 的 **prompt caching**：把「重复的前缀」缓存起来，下轮命中就近乎白读——省钱又省延迟。

## 什么是 prompt caching（术语解释）

### 它要解决的问题

调 Claude API 是**无状态**的：每次请求都得把**整段 prompt**（system + tools + 全部历史消息）重新发过去，模型每次都要把这些输入 token 从头读一遍（叫 **prefill**）。

在多轮 / agent 场景，**同一个大前缀**（system + tools + 之前的历史）**每一轮都重发、重算一遍**——你每轮都为它付**全额输入费 + 全额延迟**。工具循环里一次 `send()` 会调好几次模型，更是把这个大前缀反复重算。

### 它做了什么

让 API 把「处理某个**前缀**的结果」**缓存**下来。下次请求如果**前缀一模一样**，就直接复用缓存、不再重算：

- **缓存读**只花 ~**0.1×** 输入价（便宜约 90%），而且**快很多**（省掉重新 prefill）；
- 第一次要**写**缓存，花 **1.25×**（5 分钟 TTL）——约 **2 次请求就回本**。

### 一条铁律：前缀匹配

在某个内容块上打标记 `cache_control: {"type": "ephemeral"}`，意思是「**缓存到这里为止的前缀**」（一个**断点**）。缓存键 = 断点之前所有内容的**精确字节**。

> **铁律：断点之前任何一个字节变了，缓存就从那点起全部失效。** 所以稳定的放前面（system、工具列表），易变的放后面（每轮新问题、时间戳）。渲染顺序固定是 `tools → system → messages`——一个打在 system 末尾的断点，会**连带缓存它前面的 tools**。

### 一个具体例子

设 system + 工具 + 历史 = 10,000 输入 token，本轮新问题 = 100 token：

- **不开缓存**：每轮都付 10,100 token 全额。
- **开缓存**：第 1 轮写 ~10,000（1.25×）+ 100 全额；第 2 轮**读** 10,000（0.1×）+ 100 全额 → 那 10,000 便宜了 ~90%，还更快。

### 关键参数

- **TTL**：默认 **5 分钟**，可选 **1 小时**（写 2×）；超时没人用就过期。
- **最小可缓存前缀**：够长才缓存（`claude-sonnet-4-6` 是 **2048** token，`opus` 系 **4096**），太短**静默不缓存**（也不收写费）。
- **GA、无需 beta header**；每请求最多 **4 个断点**。
- **验证**：看响应 `usage.cache_read_input_tokens`（读了多少）/ `cache_creation_input_tokens`（写了多少）；一直是 0 说明有「静默失效源」（如把时间戳/UUID 放进了 system）。

### 官方链接

- Anthropic 官方 · Prompt caching：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- 定价（缓存读/写倍率）：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing>

**一句话**：prompt caching = 把「重复的前缀」缓存起来，下次命中就近乎白读；代价是前缀必须一字不差。

---

## 本步方案（已 grill 定；实现落在 [src/llm.ts](../src/llm.ts) 为主）

### 1. 两个断点

- **① system 末尾**：连带缓存 `tools + system`（我们的静态大头：baseSystem + 记忆 + 工具说明书）。
- **② 最后一条 message 的最后一个块**：缓存**到目前为止的整段对话前缀**。agent 循环一次 `send()` 内多次调模型、历史逐步增长，把断点每次放最后一块 → **步与步、轮与轮都命中**。
- 上限 4 个断点，用 2 个（静态头 + 增长尾）留余量。

### 2. system 数组化（`buildBody` 内部）

`system` 现在是字符串，挂 `cache_control` 需转成块数组 `[{type:"text", text, cache_control}]`。转换**只在 `buildBody` 内部**做，上层（主 agent / 子 agent / summarize 都走同一 buildBody）零改动。给「最后一条 message 末块」加 `cache_control` 时**克隆**，绝不改 `this.history`。

### 3. TTL 与开关（env）

- 默认 **5 分钟**（交互式两轮通常隔秒~分钟，最划算）；
- `AGENT_CACHE_TTL=1h` 切 1 小时（写 2×，只有「发呆很久再继续」才值）；
- `AGENT_CACHE=0` 关闭（教学上 A/B 对比开/关效果）。

### 4. usage 数据链

现在 `stream()` 完全没抓 usage。补：`message_start.message.usage` 取 `input / cache_read / cache_creation`，`message_delta.usage.output_tokens` 取输出 → 填进 `LLMResponse.usage` → `Agent` **累计本会话**（主循环 + summarize 都算，子 agent 各自算），`reset()`/`/new` 清零。

### 5. `/context` 显示（主对话 + 每个子 agent 按 id 分列）

`/context` 加缓存统计，**单位是 token，本会话累计**：主对话一行，**每个子 agent 按短 id 各占一行**（id 与 `/agents`、`agent-<id>.jsonl` 对齐，方便交叉对照）：

```
缓存·主对话：命中率 82% · 读 10240 · 写 2600 · 未缓存 180 · 输出 900 · TTL 5m（token,本会话累计）
缓存·子 ▓a2f9c1：命中率 60% · 读 3000 · 写 2000 · 未缓存 40 · 输出 500
缓存·子 ▓7b3e04：命中率 71% · 读 1800 · 写 700 · 未缓存 10 · 输出 260
```

- 命中率 = `cacheRead / (cacheRead + input + cacheCreation)`（输入里多少来自缓存）。
- **分桶**：`main`（主循环 + 摘要）；`sub` 是一张 **`id → 用量` 映射**，按派出先后列出每个子 agent。
- 实现：`Agent` 存 `usageMain` + `usageSub: Map<id, Usage>`；主循环/摘要 → 主桶;子 agent 跑完经 `SubagentDeps.onSubUsage(id, sub.totalUsage())` 回传 → CLI 调 `agent.recordSubUsage(id, u)` → 按 id 累加(同 id 合并)。`reset()`/`/new` 全清。

> **注意**：子 agent 是独立 `Agent` 实例、用量本会随它销毁而丢失;这里特意用 `onSubUsage` 把它**按 id 捞回主会话**——否则 `/context` 会漏算子 agent 的真实成本。撞满步数走 `finalizeOnBudget` 那次直连 llm 的用量未计入(边角,忽略)。

### 我们这套的「静默失效源」（要留意）

- **MCP 热加载**：`setTools` 换工具集 → tools 变（排在最前）→ 整个前缀失效。启动初期一次，可接受。
- **上下文压缩**：`compactHistory` 把旧轮摘要替换 → 消息前缀变 → 从那点失效（预期）。
- **子 agent / summarize**：不同 system + 工具 → 各自独立缓存，互不复用（正常）。

### 为什么不写 ADR / 术语表

prompt caching 是通用 Claude API 概念（不入本项目术语表）；各决策都可逆（翻个 flag），够不上 ADR 门槛。故只在本文记录。

## 下一步

- **成本显示**：有了 usage 链，可在 `/context` 或每轮后估算「省了多少钱」。
- **缓存预热**：会话开始时发一个 `max_tokens: 0` 请求预写缓存，降首轮延迟（官方 pre-warming）。
