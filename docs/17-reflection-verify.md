# 第 17 步：反思与验证闭环（`critic` 审查者）

> 前面的子 agent「会干活」，但**干完就交，没人验对错** —— 子 agent 会自信地给出错答案。这一步给 agent 一个「干完先自查、不达标就返工」的闭环：请一个**上下文隔离的对抗性审查者**（`critic`）来挑毛病。

## 和「多 agent」是两回事

- **多 agent（第 15/16 步）** 解决「怎么分工」—— 把活拆到多个隔离上下文里并行跑。
- **反思闭环（本步）** 解决「做得对不对」—— 加一道质检 + 返修。

两者正交，只在「critic 用子 agent 实现」这一点相交：反思**借用**了子 agent 的隔离能力（换个干净上下文当审查者，比自审客观），但「评估→返工→复审」这套纪律是它自己的。

## 核心：`critic` = 又一个薄工具，共用子 agent 核心

不做代码级的 generate-verify-fix 编排 harness，而是延续「能力即工具 + 提示驱动」（[ADR-0003](adr/0003-reflection-via-grounded-critic-tool.md)）。[src/subagent.ts](../src/subagent.ts) 把子 agent 机制抽成共享 `runSubagent()`，`dispatch_agent` 和 `critic` 都是它之上的薄工具，只差 system / 工具过滤 / 输入输出：

```
runSubagent(system, tools, prompt, kind)   ← 隔离/预算/存档/并行/审批透传/优雅收尾,全复用
  ├── dispatch_agent : SUBAGENT_SYSTEM, 全套−dispatch, {prompt}
  └── critic         : CRITIC_SYSTEM,   全套−{write_file,dispatch,critic}, {task,output,criteria?,artifacts?}
```

所以 critic 白捡了第 15/16 步的一切：上下文隔离、独立预算、`agent-<id>.jsonl` 存档、可并行（多份产出同时审）、危险工具审批透传、撞满步数优雅收尾。它其实是「子 agent 类型/角色」的一个**先行具体实例**（通用注册表仍是 TODO）。

## 关键设计一：critic 必须 grounded（能自己查真东西）

纯 LLM 互评容易走过场。所以 critic 是一个**带只读查验工具**的隔离子 agent：

- 工具集 = 全套 **−{`write_file`, `dispatch_agent`, `critic`}** —— 保留 `read_file` / `shell` / `http`（能读代码、grep、跑测试、必要时联网核实），去掉会改文件的、会派活的、会自审套娃的。
- **有实物**（代码/文件）→ 亲自读、亲自跑测试，锚在**硬信号**上；
- **无实物**（答案/分析/方案）→ 就事论事判文本（**软信号**）。

> 验证的强弱是固有的：能跑测试的任务硬，纯文本任务软 —— 没法给「这段分析好不好」跑单测，不硬凹。

## 关键设计二：输入必须同时带「任务 + 产出」

上下文隔离的反噬：只给结果 `2`，critic 不知道问的是不是 `1+1`，无从判对错。所以 critic 输入固定为：

| 字段 | 含义 | 必填 |
|---|---|---|
| `task` | 原始任务 / 目标 / 问题 | ✅ |
| `output` | 产出结果（答案文本 / 改了哪些文件的说明） | ✅ |
| `criteria` | 验收标准（如「必须过测试」） | 可选 |
| `artifacts` | 产物位置线索（路径），供 critic 顺着去查 | 可选 |

缺 `task` 或 `output` 直接报错（`is_error`），工具描述里也警告这一点。

## 关键设计三：裁定 + 返工纪律

critic 按固定格式输出**结构化裁定**：

```
裁定：不通过
问题：
  [严重] compactHistory 空历史会抛错（agent.ts:290）
  [次要] 变量命名前后不一致
建议：先修严重项再复审
```

主 agent 拿到裁定后的循环（system 提示引导，非代码编排）：
- **只为 `[严重]` 问题返工**，修完再复审；`[次要]` 可带注记直接交付，不为它无限打磨；
- 同一产出最多约 **2 轮**，仍不过就**如实说明剩余问题**再交付，别死磕；
- 每次 critic + 每次返工都算主 agent 干活步数，`maxSteps` 天然兜底。

## 不滥用

平凡确定的操作（`ls`、看时间、单次读取）**不必审查** —— 反思有成本，「评估比干活还贵」是反模式。system 提示里写清「重要/易错/有可验证产物才审」。

## 显示

critic 是深度 1 的子 agent，仍用 `▓<id>`（带色），但主层启动行标明是审查：

```
█ 请 critic ▓e85b1f 审查：【原始任务】… 【产出结果】…
  ▓e85b1f 调用 shell({"command":"bun test"})
  ▓e85b1f shell 结果：…
█ critic 结果：裁定：不通过 …（critic e85b1f｜1 步）
```

## 测试（`bun test`，离线）

[tests/critic.test.ts](../tests/critic.test.ts)：

- **裁定 + 工具集**：裁定进主历史；critic 子 agent 工具含 `read_file`/`shell`、排除 `write_file`/`dispatch_agent`/`critic`；
- **输入校验**：缺 `task` → `is_error`，且校验在起子 agent 前就挡下（不浪费一次子 agent）；
- **grounded**：critic 会**实际调用**查验工具核对，而非只看主 agent 的说法。

## 下一步

- **子 agent 类型/角色注册表**：把 `critic` 这种「预设角色」通用化 —— `{ [type]: { system, tools } }`，`dispatch_agent` 加 `agent_type`。
- **agent 间通信**：子 agent 之间传消息 / 共享黑板。
