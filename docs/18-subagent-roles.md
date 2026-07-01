# 第 18 步：子 agent 类型 / 角色注册表

> 到第 17 步，我们已经手写了两种子 agent：`dispatch_agent`（通用干活）和 `critic`（审查）。再想加「只读探索」「架构规划」这种角色，难道每种都手写一个工具？这一步把「角色」抽成一张**注册表**：加角色 = 加一行表项。

## 什么是「角色」

一个**角色（role / agent_type）** = 一段 **system 提示** + 一套**工具裁法** + 预算。它决定子 agent「怎么想、能用什么」。内置四个：

| 角色 | system 取向 | 工具 | 暴露方式 |
|---|---|---|---|
| `general` | 通用自主干活（默认） | 全套 −{两个 spawner} | `dispatch_agent(agent_type)` |
| `explore` | 只读探索/检索 | 再去掉 `write_file` | `dispatch_agent(agent_type)` |
| `plan` | 只读研究出方案 | 再去掉 `write_file` | `dispatch_agent(agent_type)` |
| `critic` | 对抗性审查 | 再去掉 `write_file` | 独立工具（结构化输入） |

## 核心：配置集中，暴露分两种（[ADR-0004](adr/0004-subagent-role-registry.md)）

所有角色的配置都住在 [src/roles.ts](../src/roles.ts) 的 `ROLES` 表里（单一真相）：

```ts
type Role = { description; system; exclude?: string[]; maxSteps?; kind: "prompt" | "structured" };
```

但**暴露方式**按输入形状分两种：

- **prompt 式**（`general`/`explore`/`plan`）：输入就是一段 `prompt`，经 **`dispatch_agent(agent_type, prompt)`** 选择。`agent_type` 的枚举和工具描述**从注册表动态生成** —— 加个 prompt 角色，它自动出现在 `dispatch_agent` 的可选类型里，不用改工具代码。
- **structured 式**（`critic`）：输入是结构化的 `{ task, output, … }`，塞不进「一段 prompt」，所以保留为**独立工具**；但它的 `system`/`exclude` 也从同一张表读，不再硬编码。

为什么不把 critic 也做成 `agent_type` 的一个选项？因为那样得把 `task`/`output` 揉进一段 prompt，丢掉「只给结果无法判对错」的结构化护栏（见 [docs/17](17-reflection-verify.md)）。所以：**注册表统一配置，暴露层按输入形状分流**。

## 工具裁法的基线：禁嵌套（顺带修了一个隐患）

任何角色的工具集都按这个基线算（[src/subagent.ts](../src/subagent.ts) `toolsForRole`）：

```
角色工具集 = 全套 − { dispatch_agent, critic } − 角色的 exclude
```

**基线剔除两个「会起子 agent」的工具**（`dispatch_agent` 和 `critic`），从根上保证「子 agent 不能再派子 agent、也不能请 critic」，延续 [ADR-0001](adr/0001-subagent-as-context-isolated-tool.md) 的禁递归。

> 这修正了第 17 步的一个隐患：那时 `dispatch_agent` 只剔除了自己、**漏了 `critic`**，于是被派的子 agent 其实能调 `critic` → 子 agent 起子 agent（嵌套）。现在基线统一剔除两个 spawner，根治。

角色再用 `exclude` 进一步收紧，比如 `explore`/`plan` 加 `write_file` 变只读。

## 后向兼容 & 宽松

- `agent_type` **可选，默认 `general`** —— 老用法 `dispatch_agent({ prompt })` 无缝不变。
- 传了未知/非 prompt 的 `agent_type`（比如误传 `critic`）→ **回退 `general`**，不报错。

## 显示

启动行按角色标注：

```
█ 派出 explore 子 agent ▓a2f9c1：找出所有调用 compactHistory 的地方…
  ▓a2f9c1 调用 shell({"command":"grep -rn compactHistory src/"})
█ 请 critic ▓7b3e04 审查：【原始任务】… 【产出结果】…
```

## 测试（`bun test`，离线）

[tests/roles.test.ts](../tests/roles.test.ts)：`agent_type=explore` 用 explore 的 system + 只读工具；不填 → 默认 general（保留 write_file）；非法类型宽松回退 general；**禁嵌套基线**（任何子 agent 工具集都不含 `dispatch_agent` 和 `critic`）。

## 下一步

- **用户自定义角色**：从 `.claude/agents/*.md` 之类项目配置加载角色（对标 Claude Code），让用户不改代码就加角色。本步只做了内置注册表机制。
- **agent 间通信**：子 agent 之间传消息 / 共享黑板。
