# 第 11 步：摘要压缩 + 上下文可观测

> 第 4 步的上下文管理是**有损截断**(直接丢最旧的轮)。这一步升级成 **摘要压缩(compaction)**:把旧轮调一次 LLM **浓缩成摘要**再丢,信息不全丢;并加上 **`/context`** 让上下文构成可观测。

## 策略:摘要旧轮 + 保留最近 K 轮逐字

历史超过软目标 `maxContextTokens` 时:

1. 切成 **[旧轮] + [最近 K 轮]**(K = `keepRecentTurns`,默认 2);切分点对齐"真实用户输入"(复用 `splitForCompaction`,保证两半都合法);
2. 把 **[旧轮]** 调一次 LLM 浓缩成一段摘要;
3. 历史替换为 **`[对话摘要] + 最近 K 轮逐字`** —— 远期给"要点",近期保"原文"。

**远期摘要、近期逐字** 的组合兼顾"省 token"和"细节不丢"。

## 摘要消息的形态

一条带标记的 **user 消息置顶**:`{ role: "user", content: "[对话摘要]\n<摘要>" }`。
- user 角色:首条合法、且被 `isUserInput` 当成"一轮起点",与截断/切分逻辑一致;
- `[对话摘要]` 前缀:让模型和 `/context` 一眼分清"这是压缩过的远期记忆"。

## 摘要那次 LLM 调用

[agent.ts](../src/agent.ts) 的 `summarize()`:把旧轮序列化成文本,用 `this.llm.stream` **无工具**、配聚焦 system 提示(「保留事实/偏好/决定/未完成项,省略寒暄」),drain 流取文本。**只在超限时触发**,不是每轮都调。

## 三个关键取舍

1. **软目标 + 一次性、尽力而为**:`maxContextTokens` 是我们设的**软目标**(默认 10万,远低于模型 1M 真窗口)。一次压缩;**压不到也不反复摘、不报错**,按现状继续(仍远在硬窗口内)。
   - 为什么不反复摘:**若最近 K 轮本身就超预算,摘要旧轮再多次也没用** —— 旧轮才是被摘的对象,最近轮要保留逐字。
2. **摘要失败 → 回退截断**:摘要 LLM 调用出错时,回退到第 4 步的 `truncateHistory`,保证 agent 不因摘要挂掉。(用户中断则交给 send 封口,不算失败。)
3. **摘要不落盘**:磁盘留**完整流水**(第 9 步约定),摘要只是内存工作集的派生物;续聊时读回完整历史、**重新摘要**。

## 它解决不了的:单条消息过大

轮级摘要压的是"**多轮累积**"。如果**单条消息**就巨大(超大工具结果 / 一次超大粘贴 / 全量写文件),轮级摘要**缩不动它**。业界的解法是**消息级**的:

- **diff 式编辑**(`old_string→new_string`)替代全量重写代码文件;
- **context editing**:用完即清旧的大 `tool_result`/`tool_use` 块;
- **读取分页**(read 带 offset/limit)、code execution / PTC(大中间结果不进上下文)。

这些本步**不做,列 TODO**(详见"留下的 TODO")。

## 可观测(你要的"上下文可观测")

- **压缩事件 `onCompact`**(由第 4 步的 `onTruncate` 升级而来,带 `strategy: "summarize" | "truncate"`):CLI 打印 `· 上下文压缩(摘要)：N 轮旧对话（~X → ~Y token）`。
- **`/context` 命令** + `agent.contextStats()`:随时查看
  ```
  上下文：~149 token · 5 条消息 · 3 轮 · 含摘要 ✓ · 软上限 120
  ```
- 想**观察压缩**:`AGENT_MAX_CONTEXT_TOKENS=120 bun run start`,聊几轮就会看到压缩事件(CLI 默认软上限 100000 一般触发不了)。

## 测试(`bun test`)

- [tests/context.test.ts](../tests/context.test.ts):`splitForCompaction` 切分(保留最近 K、轮数 ≤ K 时 old 为空、对齐真实 user 输入)。
- [tests/agent.test.ts](../tests/agent.test.ts):摘要压缩(FakeLLM 据 system 含"摘要"返回固定摘要 → 历史以 `[对话摘要]` 开头、`onCompact(summarize)`)、摘要失败回退截断(`onCompact(truncate)`)、`contextStats()`。

> PTY 实测:小软上限下连聊几轮 → `· 上下文压缩(摘要)：1 轮旧对话（~158 → ~91 token）`,`/context` 显示 `含摘要 ✓`。

## 留下的 TODO

1. **消息级压缩**:diff 编辑 `edit_file`、context editing(清旧大块)、read 分页 —— 解决"单条过大";
2. 精确 token 计数(`count_tokens` API)替代本地估算;
3. 摘要质量:可配置保留维度、分层摘要(摘要的摘要)。

## 下一步

1. 长期记忆(跨会话沉淀事实,而非原始流水);
2. MCP 客户端(接外部工具);RAG / 子 agent 等进阶。
