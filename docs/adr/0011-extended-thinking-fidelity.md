# 扩展思考：默认关、历史保真、内部调用不思考

## 决策

支持 Anthropic 扩展思考（extended thinking）——让模型在答复前先输出推理。四件套：

1. **请求**：开启时 body 加 `thinking:{type:"enabled",budget_tokens:N}`。
2. **解析**：`stream()` 认 `thinking` / `redacted_thinking` 内容块（`thinking_delta` 正文 + `signature_delta` 签名）。
3. **历史保真**（核心）：思考块**原样**（含 `signature`）存进 assistant 消息、回传时不删。
4. **展示**：思考正文经 `onThinkingDelta` 回调**暗色流式**显示，不 yield（不混进答复）。

配置：`AGENT_THINKING=1` 开（**默认关**）、`AGENT_THINKING_BUDGET=16000`（`<1024` 夹到 1024;`>=max_tokens` 报错）、`AGENT_SUBAGENT_THINKING=0` 关子 agent 思考。

## 为什么这样

- **默认关**：思考费 token、且仅部分模型支持，opt-in 更稳;关时 `buildBody` 不变 → **不动现有测试**。

- **历史保真是真正的难点，不是展示**：带工具调用的轮里，回传若缺思考块，API 会 400。所以思考块必须原样（含签名）留在历史并回传。取「**每轮都回传、从不删**」的最简正确策略;「轮结束即 strip」的省 token 优化留 TODO。`redacted_thinking`（加密块）同样原样保真。

- **展示走回调、不改 yield 契约**：`stream()` 的 `yield string` = 答复文本增量。思考若也 yield 会混进答复、进历史抽取。故加 `onThinkingDelta` 回调单独走 → **FakeLLM 和现有流式测试零改动**（blast radius 最小）。

- **两套持久化相反**：
  - **会话 JSONL** → 必须原样存（续聊保真，否则续聊回传缺块被拒）。
  - **长期记忆 `.memory.md`** → 抽取时**剔除**思考块：它是模型草稿（含被丢弃的假设 + 一大坨 base64 签名），沉淀进记忆是污染 + 烧 token。

- **压缩安全 = 搭「整轮不变量」的车**：摘要压缩只在「真实用户输入」处切、整轮保留或整轮丢弃、**绝不改写**块内容。故思考块要么逐字留、要么随旧轮整体摘掉;活跃工具轮的思考总在保留区。API 只要求**当前续的**工具轮带思考块，丢已结束旧轮的思考安全。

- **内部工具调用不思考**：摘要调用、记忆抽取调用传 `thinking:false`——它们产出被文本抽取，思考纯浪费。经 `CompleteOptions.thinking` 每调用覆盖（默认跟随实例 env）。

- **子 agent 默认继承**：子 agent 是真干活的 agent，用同一 LLM，契合「全局配置到处生效」（Codex/CC 也是这套，虽其子 agent 细节未见文档）。留 `AGENT_SUBAGENT_THINKING=0` 给并行烧钱场景关。

## 边界

- **模型不支持**：不预判模型清单（易过期），让 API 400 如实冒出（现有 fetchWithRetry 带详情）+ 文档写明需支持思考的模型。
- **温度**：思考要求 `temperature=1`;本仓库从不设 temperature（默认即 1）→ 天然满足，约束是「开思考时别引入自定义 temperature」。
- **缓存兼容**：两个缓存断点在 system 末 / 最后消息末块（user/tool_result），不落在思考块上;开/关思考改前缀 → 首次重建缓存（低频）。
- **adaptive 模式 TODO**：较新模型可能支持 `thinking:{type:"adaptive"}`（模型自定思考量）取代固定 budget;本步先做显式 budget，adaptive 留 TODO。
- **strip 优化 TODO**：完成轮的思考块可在回传时删以省 token,本步不做（每轮全回传，正确优先）。
