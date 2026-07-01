# agent-study

一个按步骤演进的教学型 agent 内核。领域即「agent 的运行时机制」——对话循环、工具调用、上下文管理、子任务隔离等。本文件是这些概念的**术语表**，统一中英混用时的叫法，避免同义词漂移。

## Language

### Agent 内核

**Agent**：
维护对话历史、驱动「调模型 → 执行工具 → 把结果喂回历史 → 再调模型」这一循环的对象。
_Avoid_：机器人、bot、助手（指代这个类时）

**工具循环（agent loop）**：
一次 `send()` 内部反复「调模型 → 若模型要工具就执行 → 喂回结果 → 再调模型」，直到模型不再要工具、给出最终答复的循环。
_Avoid_：对话循环（那是没有工具的第 1 步内核）

**干活步数（workSteps）**：
受 `maxSteps` 约束的步数预算；只有「调用了非辅助工具」的轮才消耗一步。是防失控的安全阀，不是任务规模的限制。
_Avoid_：步数（单说时与循环迭代次数歧义）

**辅助工具（auxiliary tool）**：
本身不推进任务、调用它不计入干活步数预算的工具（如 `todo_write`）。
_Avoid_：记账工具

**危险工具（dangerous tool）**：
碰文件系统 / 网络 / 进程、执行前需人工确认的工具。
_Avoid_：副作用工具（描述性，不作正式称呼）

**会话（session）**：
一条完整对话的持久化单位，以 append-only JSONL 落盘，可跨进程续聊。
_Avoid_：对话、conversation（指落盘单位时）

### 子 agent 模式

**主 agent**：
面向用户对话、可派发子 agent 的顶层 Agent。
_Avoid_：父 agent、根 agent

**子 agent（subagent）**：
由主 agent 派生的、**上下文隔离**的独立 Agent 实例；自主跑完一个子任务后只把**结论**交回主 agent。子 agent 不能再派子 agent。
_Avoid_：子任务、worker、子进程、child

**dispatch_agent**：
主 agent 用来派发子任务的工具。它本身非危险（副作用发生在子 agent 内部的具体工具上），也不计辅助（算一步干活）。
_Avoid_：task、run_subagent、dispatch（单用时）

**上下文隔离（context isolation）**：
子 agent 启动时只见到「派活 prompt + 自身 system 提示」，**看不到主对话历史**。因此主 agent 必须把子任务所需背景完整写进 prompt。
_Avoid_：沙箱、隔离（泛指时）

**预算隔离（budget isolation）**：
子 agent 拥有独立的 `maxSteps` 与 `maxContextTokens`，其消耗不影响主 agent 的预算。主 agent 花 1 步派活，子 agent 内部可跑满自己的预算。

**结论（conclusion）**：
子 agent 返回给主 agent 的最终文本（含一小段过程元信息，如步数 / 用过的工具）。这是主 agent 从一次派活中**唯一**收到的东西——中间过程不进主上下文。
_Avoid_：结果、输出、答复（泛指时）

**子档案（subagent transcript）**：
子 agent 内部完整历史的独立存档，与主会话流水分开保存，仅供事后观测调试；主上下文与主会话流水都不含它。
_Avoid_：子会话、子日志

**并行派活（parallel dispatch）**：
主 agent 在同一轮里同时派出多个子 agent 并发执行、一起收结（受并发上限约束）。仅当该轮工具调用全为 `concurrent` 工具时发生，否则退回串行。
_Avoid_：多开、并发子任务

### 反思与验证

**critic（审查子 agent）**：
主 agent 请来的、上下文隔离的**对抗性审查者**。带只读查验工具，能亲自核对真实产物（有实物时读代码/跑测试）或就事论事判文本（无实物时），产出结构化裁定。自己不修改任何东西，也不能再派子 agent。
_Avoid_：评审、reviewer、评委、judge

**裁定（verdict）**：
critic 的产出：二元结论（通过 / 不通过）＋ 分级问题清单（`[严重]` / `[次要]`）＋ 建议。主 agent 据此决定是否返工。
_Avoid_：评分、打分、score

**反思闭环（reflection loop）**：
「产出 → critic 审查 / 跑测试 → 只为 `[严重]` 问题返工 → 复审」的循环，带迭代上限（最多约两轮、平凡任务不审）。验证的强弱取决于有无硬信号（可跑的测试 = 硬；纯文本判断 = 软）。
_Avoid_：自我批评、self-critique（特指无隔离、无查验的自评）
