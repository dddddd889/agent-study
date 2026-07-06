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
由主 agent 派生的、**上下文隔离**的独立 Agent 实例；自主跑完一个子任务后只把**结论**交回主 agent。子 agent 不能再派子 agent、也不能请 critic（两个会起子 agent 的工具都被剔除）。
_Avoid_：子任务、worker、子进程、child

**角色 / agent_type（subagent role）**：
子 agent 的预设身份 = 一段 system 提示 + 一套工具裁法，决定它「怎么想、能用什么」。内置 `general`（通用干活，默认）/ `explore`（只读探索）/ `plan`（只读规划）/ `critic`（对抗性审查）。
_Avoid_：类型（单说时泛指）、模式、人格

**角色注册表（role registry）**：
集中登记所有角色配置（system、工具裁法 `exclude`、预算、暴露方式）的单一真相表（`src/roles.ts`）。加角色 = 加一行表项。prompt 式角色经 `dispatch_agent` 的 `agent_type` 选择；结构化输入的角色（critic）配置也在表里、但暴露为独立工具。
_Avoid_：配置表（泛指）、agent 列表

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

### 文件编辑

**Edit（精确编辑）**：
通过「唯一命中的字符串替换」精确改文件某一处的工具（`old_string → new_string`，默认要求命中唯一）。区别于 `write_file`（整文件新建/重写）。空 `new_string` 即删除那段。
_Avoid_：patch（那是未来的 `apply_patch`）、改写、修改

**先读再改（read-before-edit）**：
一条不变量：`Edit` 前必须先 `read_file`（或 `write_file`）读过该文件。每个 agent 各记一份「已读集合」（运行时、非持久），防盲改与陈旧。
_Avoid_：读写校验

**补丁（apply_patch）**：
一次性、跨多文件、可增删文件的**原子**编辑（Codex 风格 diff）。区别于 `Edit`（单处）/ `write_file`（单文件重写）。靠**上下文内容定位**（非行号）、全或无应用。
_Avoid_：diff、打补丁（口语）

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

### 权限与安全

**权限模式（permission mode）**：
会话级的审批策略档位，决定各类工具「直接放行 / 弹审批 / 直接拒绝」。四档：`default`（改与执行都问、只读放行）、`acceptEdits`（编辑自动、执行仍问）、`plan`（只读，改与执行一律拒）、`yolo`（全放行）。运行时用 `/mode` 切换、启动读 `AGENT_MODE`。子 agent 派生时继承主 agent 当前模式。
_Avoid_：权限档、审批档、sandbox（那是路径沙箱）

**工具类别（tool category）**：
每个工具标注的一个维度 `read`（只读）/ `edit`（改文件）/ `exec`（执行&网络），权限模式据此决策。取代旧的 `dangerous` 布尔标记：`edit`/`exec` 即「危险」、`read` 即「安全」。缺省按 `read`。
_Avoid_：危险标记、dangerous

**策略（policy）**：
「工具类别 × 权限模式」查出的三态结果之一：`allow`（不问直接跑）/ `ask`（走人工确认）/ `deny`（不问直接拒，回一条 is_error 说明原因）。优先级：`deny` > 「本会话总是允许」——即 `sessionAllowed` 只在 `ask` 档生效，`plan` 的 `deny` 无视它硬拒。
_Avoid_：权限、许可

**plan 模式（plan mode）**：
只读的权限档：改文件/执行命令一律 `deny`；并向 system 注入一行指令，让模型主动产出【方案/计划】而非撞拒绝，需要动手时提示用户切 `acceptEdits`。注意与 plan **角色**（`src/roles.ts` 里的只读规划子 agent 人格）分属不同命名空间，是两回事。
_Avoid_：规划角色（那是 plan 角色）、只读沙箱

**路径沙箱（path sandbox）**：
把「按路径操作文件」的工具（read/write/edit/patch/grep/glob）**词法**限制在工作目录（`AGENT_SANDBOX_ROOT`，默认 cwd）内的硬边界。管**我们自己的文件工具**，管不到 shell。
_Avoid_：执行沙箱（那是下一层）、权限模式

**执行沙箱（execution sandbox）**：
把 **`shell`** 命令关进**操作系统级**沙箱里跑的硬边界：macOS 用 `sandbox-exec`（Seatbelt），Linux 用 `bwrap`。默认策略 = **workspace-write**（写限工作目录 / 读放开 / 禁网）。与权限模式**正交**：模式决定「要不要问」，执行沙箱决定「放行后怎么跑」——`yolo` 下 shell 仍被它框住。默认开，`AGENT_SANDBOX_EXEC=0` 关、`AGENT_SANDBOX_EXEC_NET=1` 放网。沙箱不可用时 **fail-closed**（拒跑 shell）。
_Avoid_：路径沙箱、命令白名单（那是被否掉的脆弱替代）

**workspace-write（写限工作区）**：
执行沙箱的默认策略：文件**写**只能落在工作目录内、文件**读**放开全盘、**网络**默认禁。对标 Codex 的同名档。「读放开 + 禁网」的组合意思是：读得到密钥也发不出去。
_Avoid_：只读沙箱、全隔离

**SSRF（服务端请求伪造）**：
诱导跑在特权网络位置的 agent 替攻击者发请求，够到公网够不到的东西（`localhost`、内网网段、云元数据 `169.254.169.254`）或外发本地数据。agent 有**两条联网出口**、各自防：**shell** 靠执行沙箱**禁网**（连 socket 都出不去）；**`http_request`** 靠本机的**私有 IP 黑名单**（第 26 步，`http_request` 不在 shell 沙箱内、是 agent 自己的 fetch，需独立防护）。
_Avoid_：注入（泛指）、越权

**私有 IP 黑名单（private-IP blocklist）**：
`http_request` 的 SSRF 防线：发请求前先 DNS 解析目标 host，把**解析出的所有 IP** 逐个对私有/保留段（loopback/私网/link-local/云元数据/IPv6 ULA + IPv4-mapped 等）做 CIDR 校验，命中即拒。校验**解析后的 IP**（而非主机名字符串）→ 天然免疫十进制/十六进制混淆 IP、以及域名指向内网。
_Avoid_：IP 白名单（那是另一个）、防火墙

**DNS 重绑定（DNS rebinding）**：
SSRF 绕过：攻击者控制域名 DNS，校验时解析到公网 IP、`fetch` 实连时解析到内网 IP（两次解析不同）。本仓库**「解析+校验一次再正常 fetch」**挡住静态指向内网/混淆 IP/`localhost`，但**不防主动重绑定**（要彻底堵需把连接钉在已校验 IP 上，会牺牲 HTTPS）——列为**已知局限**。
_Avoid_：TOCTOU（泛指时）、DNS 投毒

**HTTP 白名单（http allowlist）**：
可选的**外泄**防线（非 SSRF）：`AGENT_HTTP_ALLOWLIST` 列出的 host 才放行、其余（含公网）拒。默认空=不启用，保持 agent 自由访问公网;锁死场景才开。日常公网外泄由**审批**兜（`http_request` 是 `exec` 类，default 下每次发请求都问）。
_Avoid_：私有 IP 黑名单（那是防 SSRF）、沙箱

**fail-closed（不保则拒）**：
安全护栏的默认姿态：不能保证安全时**拒绝执行**而非放行。执行沙箱不可用（无 `sandbox-exec`/`bwrap`）→ 禁 shell 并提示，而不是静默裸跑。反义是 fail-open（出问题也照跑）。
_Avoid_：fail-safe（含义相近但易混）、默认拒绝

### 扩展思考

**扩展思考（extended thinking）**：
让模型在给出答复前先输出一段**推理过程**。请求体加 `thinking:{type:"enabled",budget_tokens:N}` 开启;第 27 步实现。默认关，`AGENT_THINKING=1` 开、`AGENT_THINKING_BUDGET` 定预算（默认 16000，`budget < max_tokens`）。
_Avoid_：推理、reasoning（口语可，正式用「扩展思考」）、CoT

**思考块（thinking block）**：
模型产出的一类内容块 `{type:"thinking",thinking,signature}`（以及加密的 `redacted_thinking`）。思考正文经 `onThinkingDelta` 暗色流式显示，**不混进答复文本**（`extractText` 只取 `text` 块）。
_Avoid_：思考消息、reasoning block

**历史保真（thinking fidelity）**：
思考块必须**原样**（含 `signature`）存进会话历史并回传——带工具调用的轮里缺思考块会被 API 拒。压缩对它「整轮保留 or 整轮丢弃、绝不改写」（靠「切点只在真实用户输入」的整轮不变量）;JSONL 落盘保真、续聊读回原样;但**蒸馏历史成文本时（长期记忆抽取、会话摘要压缩）都剔除思考块**（草稿非事实、含一大坨签名、且省 token；结论已在 text/tool_use/tool_result 里，无信息损失。只改蒸馏输入，主循环回放仍原样保真）。
_Avoid_：保留思考、思考持久化

**思考预算（thinking budget）**：
`budget_tokens`：思考最多花多少 token，占 `max_tokens` 的一部分（故须 `budget < max_tokens`，否则报错;`< 1024` 夹到 1024）。内部工具调用（摘要、记忆抽取）传 `thinking:false` 不思考;子 agent 默认继承、`AGENT_SUBAGENT_THINKING=0` 可关。
_Avoid_：思考上限、token 预算（泛指时）

### 上下文压缩与记忆游标

**摘要压缩（compaction）**：
历史超软目标 `maxContextTokens` 时，把旧轮调 LLM 浓缩成摘要、只保留最近 K 轮逐字的动作。远期给要点、近期留原文。区别于第 4 步的有损截断（直接丢旧轮）。
_Avoid_：压缩（泛指）、截断（那是回退兜底）

**记忆游标（memory cursor）**：
主流水里的一个位置，标记「此位置之前的原始轮已被冻结进摘要」。之后的压缩只处理游标之后新老化的轮，游标之前的一律不再喂给模型重摘。
_Avoid_：指针、offset、书签

**冻结块（frozen block）**：
一段已定稿、**永不再被模型重写**的对话摘要。按序累积成 s1、s2、…，斩断「摘要的摘要」的退化链。
_Avoid_：摘要（泛指时）、快照

**摘要区（summary zone）**：
内存历史开头那串冻结块的整体（`history` 的前 `frozenCount` 条）。`splitForCompaction` 把它当不可动的前缀跳过。
_Avoid_：摘要头、摘要前缀

**增量冻结（incremental freeze）**：
一次常态压缩：只把「游标与最近 K 轮之间」新老化的轮摘成**一个新冻结块**追加到摘要区，游标右移，已冻结块一字不动。生成时把摘要区作**只读上下文**喂入保连贯（看≠改写）。
_Avoid_：增量摘要（口语可）、追加摘要

**合并（summary merge）**：
冻结块数 ≥ M（默认 5）**或**摘要区占比 ≥ r（默认 25%）时触发的低频事件：把现有全部冻结块重摘塌成一块、块计数归零。用可控的低频退化换摘要区不无限增长。
_Avoid_：再摘、压平、重摘（泛指）

**摘要缓存（summary sidecar）**：
旁挂在 `<id>/summary.jsonl` 的**派生缓存**：一行一个冻结块、末行 `cursorAfter` 即当前游标。主流水（`<id>.jsonl`）才是唯一真相——缓存可自由重写（合并时）、可整体丢弃（校验不过就退回全量重摘），丢了自愈、绝不因它丢历史。只主 agent 落盘（子 agent 不续聊）。
_Avoid_：摘要存档、快照文件、摘要流水
