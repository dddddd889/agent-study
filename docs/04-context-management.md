# 第 4 步：上下文管理（token 估算 + 整轮截断）

📌 **后续改动**:本步的"整轮**截断丢弃**"在第 11 步升级为"**摘要压缩**"(旧轮先调 LLM 摘要再丢,信息不全丢);回调 `onTruncate` 也改名 `onCompact`(带 strategy)。本文保留初始设计,升级见 [docs/11](11-summarization-compaction.md)。`truncateHistory` 仍保留为摘要失败时的回退。

> 前面几步里,`Agent` 每轮都把**完整 history** 发给模型。对话越长,发的 token 越多 —— 越慢、越贵,最终会撞上模型的上下文窗口。
> 这一步给 agent 装上**上下文管理**:估算历史 token,过长时按「整轮」丢弃最旧的对话。

这一步**不改 agent 的工具循环**,只在每次调模型前插入一道「校长度 → 必要时截断」的关卡。

## 先认清一个事实

`claude-sonnet-4-6` 的上下文窗口是 **1M token**,所以在这个学习项目里你几乎碰不到真实上限。这一步的价值是**学会上下文管理的机制**,而不是救场。想看到它生效,把阈值调小即可(见下)。

## 设计取舍(本步只做最简)

| 维度 | 选择 | 留作 TODO |
|---|---|---|
| token 计数 | 本地启发式估算(零成本、可离线测) | 精确计数改用 `count_tokens` API |
| 过长策略 | **截断**(丢最旧的轮) | **摘要压缩**(调 LLM 把旧轮浓缩) |
| 历史存储 | **就地遗忘**(真删 `this.history`) | 保留完整历史、只发截断副本 |

## token 估算([src/context.ts](../src/context.ts))

`estimateTokens(messages)` 用一个简单经验法则:**ASCII 约 4 字符/token,非 ASCII(中文等)约 1 token/字**。只求量级正确,不追求精确 —— 上下文管理的**触发逻辑和截断算法**才是重点。

工具调用的参数(`tool_use.input`)和工具结果(`tool_result.content`)也会计入估算。

## 深入:token 到底怎么记?业界做法 + 一个坑

我们这步是每轮把整段历史**从头估一遍**。一个自然的问题:能不能把 token 数**绑到每条消息上**,只算一次?能,而且业界确实这么做 —— 但要分清两种"绑定":

**1. 把 API 返回的「真实 usage」绑到消息上(精确)**
每次响应里,Anthropic / OpenAI 都在 `usage` 字段返回精确的 `input_tokens / output_tokens / cache_*`。框架把它存到对应消息上:LangChain 的 `AIMessage.usage_metadata`、Vercel AI SDK 每步的 `usage`。这是**权威数字**,但只覆盖「模型生成的那条」和「当时整个 prompt」,不是逐条的。

**2. 给每条消息缓存一个「估算值」用于裁剪决策(近似)**
为了决定"要不要截断",框架逐条估 token 并求和:LangChain 的 `trim_messages(token_counter=...)`、OpenAI cookbook 的 `num_tokens_from_messages`(它逐条算,**还给每条加固定开销** —— 每条 +3 token 的角色/分隔符,助手起始再 +3)。我们这步做的就是(2),只是更糙、且没缓存。

### 一个必须知道的坑:token 不是严格可加的

把"每条的 token"加起来 **≠ 整个 prompt 的精确 token**,因为:

- **跨边界合并**:分词器可能把相邻消息的字符合并成一个 token;
- **每条消息有框架开销**:角色标记、消息分隔符(就是 OpenAI 那 +3/条);
- **system 和 tools 的外壳**也占 token,却不属于任何一条 message。

所以"绑在每条上的数字"适合做 **「该不该裁」的决策**,不适合做 **计费 / 精确预算**。要精确,只能信 API 返回的 `usage` 或 `count_tokens`。

### 怎么"绑"(三种实现)

| 方式 | 做法 | 取舍 |
|---|---|---|
| **A. WeakMap 旁路缓存** | `WeakMap<Message, number>`,每条只估一次 | 不污染 `Message` 类型;消息被丢弃后自动 GC;但"看不见" |
| **B. 给 `Message` 加字段** | `Message { role, content, tokens? }` | 直观;但把「发给 API 的线上数据」和「本地记账」混进一个类型 —— **不推荐** |
| **C. 内部包装类型** | history 存 `{ message, tokens }[]`,发送时 `.map(e => e.message)` | 概念最干净(线上数据 vs 记账分离),最贴近 LangChain 的 `usage_metadata` 思路;改动中等 |

**当前实现**属于(2)且**没缓存**:`compactHistory()` 每轮 `estimateTokens(this.history)` 全量重扫,`truncateHistory` 还会对候选后缀反复重算(最坏接近 O(n²))。对本项目的规模可忽略,但确实有优化空间 —— 用 A 或 C 让每条只算一次即可。这条已列入下面的 TODO。

## 整轮截断的安全约束(本步最关键)

不能随便丢最旧的**单条**消息,否则会被 Anthropic API 直接 400。两条硬规则:

1. **工具配对**:assistant 的每个 `tool_use` 必须紧跟带对应 `tool_result` 的 user 消息。丢了 `tool_use` 却留下 `tool_result` → 「孤儿 tool_result」→ 400。
2. **首条必须是干净的 user 输入**:截断后第一条不能是「只含 tool_result 的 user 消息」。

`truncateHistory(messages, maxTokens)` 的做法:

- 把历史看成若干**轮**:一轮 = 一条真实 user 输入 + 它引发的 assistant / tool_result 们。
- **判定「一轮的起点」的巧妙之处**:本项目约定 user 输入用**字符串** content 压入,工具结果用 **ContentBlock[]** 压入。所以「`role==="user"` 且 content 是字符串」就是一轮的起点,一个判断搞定。
- 从最旧的轮**整轮**丢弃,直到估算 token ≤ 阈值;只在「轮起点」对齐 → 天然满足上面两条规则。
- **至少保留最近 1 轮**(即使它自身就超阈值 —— 那只能靠摘要进一步压缩)。

## 接入 Agent([src/agent.ts](../src/agent.ts))

- 新增选项 `maxContextTokens`(默认 **100000**)和 `onTruncate` 回调。
- `send()` 循环**顶部**调用私有方法 `compactHistory()`:估算 → 超限就 `truncateHistory` → 就地更新 `this.history` → 触发 `onTruncate`。放在循环顶部,是因为工具循环里 history 还会增长,每轮校一次最稳;当前进行中的这一轮一定被保留。

## 怎么观察它生效

默认 100000 在 demo 里基本不会触发。把阈值调小:

```ts
const agent = new Agent(llm, {
  maxContextTokens: 60,           // 故意调小
  onTruncate: ({ droppedTurns, beforeTokens, afterTokens }) =>
    console.log(`已遗忘 ${droppedTurns} 轮（~${beforeTokens} → ~${afterTokens} token）`),
});
```

连聊几轮就会看到:

```
你> 我叫小明
AI> 你好，小明！...
你> 我养了一只猫
  · 上下文超限，已遗忘 1 轮旧对话（~70 → ~41 token）
AI> ...
```

注意:被丢的那轮信息**彻底没了** —— 几轮后 agent 会"忘记"你叫小明。这正是截断(有损)的本质,也是为什么「摘要压缩」是有价值的下一步。

## 测试(`bun test`)

- [tests/context.test.ts](../tests/context.test.ts):`estimateTokens` 单调性 + 能估内容块;`truncateHistory` 的 5 条安全约束(未超阈值原样返回、超阈值丢最旧且落进预算、首条是真实 user 输入、不拆散 tool_use/tool_result、至少留最近 1 轮)。
- [tests/agent.test.ts](../tests/agent.test.ts):传一个很小的 `maxContextTokens`,连发几轮后断言历史变短、首条是真实 user 输入、`onTruncate` 被触发、传给 LLM 的是截断后的短历史。

## 留下的 TODO

1. 精确 token 计数 → `count_tokens` API
2. 摘要压缩 → 把旧轮调一次 LLM 浓缩成一段摘要塞回(比截断更忠实)
3. 保留完整历史 → 改为「只发截断副本」或把旧轮归档,而非就地真删

## 下一步

1. **摘要压缩**(落实 TODO 2,比截断更聪明)
2. **流式输出(SSE)**:边生成边显示
3. **持久化**:把 `history` 存盘,跨进程续聊
