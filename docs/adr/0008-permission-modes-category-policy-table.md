# 权限模式：会话级「类别 × 模式 → 策略」表

## 决策

把审批从「逐个危险工具 y/a/n ↔ 全放行」两极，升级为**会话级权限模式**。核心是一张表：

```
模式        read   edit   exec
default     allow  ask    ask
acceptEdits allow  allow  ask
plan        allow  deny   deny
yolo        allow  allow  allow
```

- 每个工具标注**类别** `read`/`edit`/`exec`（`Tool.category`，缺省 `read`），取代旧的 `dangerous` 布尔。
- 模式决策收口在 `src/permission.ts` 的 `resolvePolicy(mode, category) → allow|ask|deny`。
- `Agent` 持有当前模式，在 `checkPermission` 里：`allow`→直接跑、`deny`→回 is_error 说明原因、`ask`→走既有 `onApprove`（y/a/n + `sessionAllowed`）。
- 运行时 `/mode <名>` 切换、启动读 `AGENT_MODE`（默认 `default`）。子 agent 派生时**继承**主 agent 当前模式。

## 为什么这样

- **模式 = 类别→策略表，而非逐工具配置**：少数几档就覆盖所有工具，加新工具只需归个类，不用在每个模式里加条目。能表达最有用的中间态「自动改、但 shell 仍问」（`acceptEdits`）。

- **删 `dangerous`、改 `category`**：旧 `dangerous` 把「读密钥」（read_file/grep）和「改/执行」（write/shell）混为一谈。权限模式要按读/改/执行区别对待，`category` 是更贴切的正交维度；`edit`/`exec`＝危险、`read`＝安全，一个字段说清。副作用：read_file/grep 归 `read`，`default` 下从「每次问」变为**放行**——这是刻意的体验修正（路径沙箱已兜底读只在界内）。

- **`deny` > `sessionAllowed`**：`plan` 必须硬拒写操作，即便用户之前对某工具选过「总是允许」。故 `sessionAllowed` 只在 `ask` 档生效；`allow`/`deny` 无视它。切模式不清空 `sessionAllowed`（切回 `ask` 档时旧的「总是」仍在，符合直觉）。

- **plan 模式注入 system**：只靠 `deny` 拒绝串是被动的——模型会先试写、撞墙才知道。给 plan 注入一行指令让它**主动**产出计划、需要动手时提示切 `acceptEdits`。代价：system 是提示词缓存断点，切模式会失效前缀、下轮重建——低频操作，可接受。**`default` 不注入**（它是基线，模型本按默认行为跑，保持热路径缓存稳定）。

- **删除 `AGENT_ALLOW_ALL`**：它与 `AGENT_MODE=yolo` 完全等价，留着就是一件事两种说法（两条路径、两处文档）。教学仓库里干净 > 向后兼容，直接并入。

## 边界

- **不含 shell 的 OS 级沙箱/命令白名单**：shell 归 `exec`，受模式管（default 问、plan 拒、yolo 放），因此 plan/default 下第 23 步留的「shell 绕过口」被审批/拒绝部分收紧；但 `yolo`/`allow` 档下 shell 仍能在 OS 层越界——真正收紧要等执行沙箱，留 TODO。
- **MCP 外部工具归 `exec`**：无法预知外部工具是否只读，按最保守处理（default 问、plan 拒）。
- 与**路径沙箱**（ADR-0007）正交：沙箱管「路径能不能碰」，模式管「操作要不要问/拒」，两者叠加。
- 与**角色**（ADR-0004）正交：角色管「有哪些工具」（如 critic 排除 write_file），模式管「这些工具要不要问/拒」。工具须同时被角色允许**且**被模式放行。
- **plan 模式**（审批档）与 **plan 角色**（`src/roles.ts` 的只读规划子 agent 人格）同名但不同物，分属不同命名空间。
