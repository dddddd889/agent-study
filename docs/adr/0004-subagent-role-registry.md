# 子 agent 角色以「注册表」集中登记，配置与暴露方式分离

## 决策

子 agent 的「角色」（system 提示 + 工具裁法 + 预算）集中在一张**注册表** `src/roles.ts` 里登记，而不是每个角色手写一个工具。`dispatch_agent` 长出一个 `agent_type` 参数，从注册表动态生成可选类型的枚举与描述；加一个新角色 = 在表里加一行。

## 配置集中、暴露分两种

角色的**配置**（`{ description, system, exclude?, maxSteps?, kind }`）全部住在注册表里（单一真相）；但**暴露方式**按输入形状分两种：

- **prompt 式**（`general` / `explore` / `plan`）：输入就是一段 `prompt`，经 `dispatch_agent(agent_type, prompt)` 选择。
- **structured 式**（`critic`）：输入是结构化的 `{ task, output, … }`，塞不进「一段 prompt」，所以保留为**独立工具**——但它的 `system` / `exclude` 也从同一张注册表读，不再硬编码。

考虑过把所有角色都做成 `dispatch_agent(agent_type)` 的参数（Q1-C），但那样 critic 必须把 `task`/`output` 揉进一段 prompt，丢掉「只给结果无法判对错」的结构化护栏。也考虑过每个角色各生成一个独立工具（Q1-B），但对绝大多数「prompt 式」角色是多余的机制。折中：**注册表统一配置，暴露层按输入形状分流**。

## 工具裁法的基线：禁嵌套

任何子 agent 角色的工具集 = `全套 − {dispatch_agent, critic} − 角色的 exclude`。**基线剔除两个会起子 agent 的工具**（`dispatch_agent` 和 `critic`），从根上保证「子 agent 不能再派子 agent / 不能再请 critic」，延续 [ADR-0001](0001-subagent-as-context-isolated-tool.md) 的禁递归——这也修正了第 17 步只剔除 `dispatch_agent`、漏了 `critic` 的嵌套隐患。角色再用 `exclude` 进一步收紧（如 `explore`/`plan` 加 `write_file` 变只读）。

## 边界

- **默认 `general`**：`agent_type` 可选，不填即 `general`——老用法 `dispatch_agent({prompt})` 无缝不变。
- **非法类型宽松回退**：未知 `agent_type` → 回退 `general`，不报错。
- **用户自定义角色**（从 `.claude/agents/*.md` 之类项目配置加载）留作 TODO——那是「让用户扩展」，与「建立注册表机制」是两件事。
