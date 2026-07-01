# 并行执行模型：`concurrent` 工具标志 + 「全并发才并行」

## 决策

Agent 的工具执行循环支持并发，但用**保守触发**：给 `Tool` 加一个 `concurrent?` 标志，**仅当某一轮的工具调用全部是 `concurrent` 工具时**才并发执行（受并发上限约束），只要混进任何非 `concurrent` 工具就退回串行。`dispatch_agent` 标 `concurrent: true`，于是「一轮派多个子 agent」会并行，而普通有副作用的工具（`write_file` / `shell`）永远串行。

## 为什么

考虑过 **B：无脑并行一轮内所有工具**——实现最省，但并发跑 `write_file`/`shell` 会有副作用竞态、顺序丢失。也考虑过 **C：在代码里特判 `dispatch_agent`**——把通用能力焊死在一个工具名上，不可复用、破坏「Agent 通用、能力靠标志描述」的一致性（`dangerous`/`auxiliary` 都是标志）。选「标志 + 全并发才并行」让并发成为 Agent 的一个通用、安全默认关闭的能力，而「子 agent 可并行」只是它标了这个 flag 的自然结果。

## 范围与边界

- **并发上限**：异步信号量，默认 5（`AGENT_MAX_CONCURRENCY`），防一次派几十个打爆 API / 本机。
- **无嵌套并行**：子 agent 不能再派子 agent（见 [ADR-0001](0001-subagent-as-context-isolated-tool.md)），所以并发只发生在主 agent 的一轮里。
- **失败隔离**：并发批次用 `allSettled` 式结算，每个 tool_use 各自成/败，互不牵连；结果按原顺序 / id 配对回填。
- **不变量延续**：中断时等所有在飞子 agent 各自封口后，再给未结算的 tool_use 补取消结果、封口整轮——保持「每个 tool_use 都有配对 result、历史合法」这条既有铁律。
- **标识分配**：子 agent 存档标识改为**随机短 id**（`agent-<id>.jsonl`），避免并发同时算出同一顺序号而撞号；短 id 同时用于显示上的「同层区分 + 配色」。
