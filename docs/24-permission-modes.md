# 第 24 步：权限模式（会话级审批策略）

> 到第 23 步，审批只有**两极**：逐个危险工具 `y/a/n`，或 `AGENT_ALLOW_ALL=1` 全放行。中间没有档位——想「自动批准编辑、但 shell 仍要问」做不到。这一步引入**权限模式**：几档会话级策略，决定各类工具「直接放行 / 弹审批 / 直接拒绝」。

## 核心：一张「模式 × 类别 → 策略」表

[src/permission.ts](../src/permission.ts) 是单一真相：

```
模式         read    edit    exec
default      allow   ask     ask
acceptEdits  allow   allow   ask
plan         allow   deny    deny
yolo         allow   allow   allow
```

- **工具类别**（`Tool.category`）：`read`（只读）/ `edit`（改文件）/ `exec`（执行&网络），缺省 `read`。取代旧的 `dangerous` 布尔——`edit`/`exec` 即「危险」、`read` 即「安全」，一个字段说清。
- **策略**三态：`allow` 不问直接跑 / `ask` 走人工确认 / `deny` 不问直接拒（回一条带原因的 is_error）。
- **决策收口**在 `resolvePolicy(mode, category)`；`Agent.checkPermission` 据【当前模式 + 工具类别】查表。

## 四档模式（对齐 Claude Code / Codex）

| 模式 | 含义 |
|---|---|
| `default` | 只读放行，改文件/执行前逐个确认。**注意**：read_file/grep 归 `read`，从旧的「每次问」改为**放行**——刻意的体验修正，路径沙箱已兜底读只在界内。 |
| `acceptEdits` | 文件编辑自动放行，shell/网络仍需确认。写代码最常用的中间态。 |
| `plan` | 只读探查，任何改文件/执行**一律拒**（不问）。对标 CC plan / Codex read-only。 |
| `yolo` | 一切自动执行、不再确认（= 旧的 `AGENT_ALLOW_ALL`）。对标 CC bypassPermissions。 |

## 决策落在 Agent、`onApprove` 退化成纯 UI

三态里只有 `ask` 需要弹问。所以：

- `Agent` 持有当前模式，在 `checkPermission` 里算策略：`allow`→跑、`deny`→拒、`ask`→才调 `onApprove`。
- `onApprove`（[src/cli.ts](../src/cli.ts)）因此**只剩** `y/a/n` 交互 + 「本会话总是允许」记忆，不再判断模式。`yolo` 全 `allow`，根本不会走到 `onApprove`。

```ts
// checkPermission 要义
const policy = resolvePolicy(this.mode, tool.category ?? "read");
if (policy === "allow") return null;                 // 直接跑
if (policy === "deny")  return `[${mode} 模式禁止…]`; // is_error 回模型
if (this.alwaysAllowed.has(name)) return null;       // ask 档:选过总是
return onApprove(...) → once/always/deny;            // ask 档:弹问
```

## `deny` > 「总是允许」

优先级：`allow` → `deny` → `ask`。`sessionAllowed`（本会话总是允许）**只在 `ask` 档生效**；`plan` 的 `deny` 无视它硬拒（你在 default 对 shell 选过「总是」，切到 plan 照样拒）。切模式**不清空** `sessionAllowed`（切回 ask 档旧的「总是」仍在，符合直觉）。

## `/mode` 运行时切换 + `AGENT_MODE` 默认

- REPL 命令 `/mode`（不带参列出当前档 + 选项）、`/mode <名>` 切换。运行时切换是价值所在——尤其 **plan 探完 → 切 acceptEdits 动手** 的经典交接。
- 启动读 `AGENT_MODE`（默认 `default`）。
- 子 agent 派生时**继承**主 agent 当前模式（plan 下子 agent 也只读）。

## plan 模式注入 system（主动规划）

只靠 `deny` 拒绝串是**被动**的——模型会先试写、撞墙才知道。所以 plan 模式向 system 注入一行指令，让它**主动**产出方案、需要动手时提示切 `acceptEdits`。

- **`default` 不注入**：它是基线，模型本按默认行为跑；也保持提示词缓存热路径稳定（system 是缓存断点，见 docs/22）。切到非默认模式会让 system 变、缓存前缀失效、下轮重建——**低频操作，可接受**。

## 与相邻能力的边界

- **不含 shell 的 OS 级沙箱**：shell 归 `exec`，受模式管（default 问、plan 拒、yolo 放）。所以 plan/default 下第 23 步留的「shell 绕过口」被审批/拒绝**部分收紧**；但 `yolo`/`allow` 档下 shell 仍能在 OS 层越界——真正收紧要等执行沙箱，留 TODO。
- **MCP 外部工具归 `exec`**：无法预知外部工具是否只读，按最保守处理。
- 与**路径沙箱**（docs/23）正交：沙箱管「路径能不能碰」，模式管「操作要不要问/拒」。
- 与**角色**（docs/18）正交：角色管「有哪些工具」，模式管「这些工具要不要问/拒」；工具须同时被角色允许**且**被模式放行。
- **plan 模式** ≠ **plan 角色**：前者是审批档，后者是 [src/roles.ts](../src/roles.ts) 的只读规划子 agent 人格，同名不同物。

## 开关（env）

- `AGENT_MODE=default|acceptEdits|plan|yolo`：启动初始模式（默认 default）。
- 旧的 `AGENT_ALLOW_ALL` **已删除**——用 `AGENT_MODE=yolo` 代替（二者等价，留着是一件事两种说法）。

## 测试（`bun test`，离线）

[tests/permission.test.ts](../tests/permission.test.ts)：策略表四档×三类、类别缺省、`isPermissionMode`、`initialMode` 读 env、`modeSystemLine`（default 空 / plan 主动规划）；Agent 集成：plan 硬拒 edit（不问不跑、回带原因 is_error）、plan 放行 read、acceptEdits 自动改但 exec 仍问、default 改要问、yolo 全放、`deny>always`、`setMode/getMode`、system 注入、子 agent 继承 plan。

## 下一步

- **执行沙箱**：收紧 shell（OS 级沙箱 / 命令白名单），补上 `yolo`/`allow` 档下 shell 的 OS 层越界。
- **用户自定义模式**：把 `MODES` 表做成可配置（如 `.claude/` 里加档）。
- **越界转批准**：路径沙箱的「越界」目前是硬拒（docs/23），可考虑在某些模式下降级为 `ask`。
