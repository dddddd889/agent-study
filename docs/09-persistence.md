# 第 9 步：持久化(对话存盘 + 跨进程续聊)

> 前面历史只在内存里,进程一退就没了。这一步把对话**存盘**,支持**跨进程续聊**:下次带会话 id 启动,接着上次聊。

## 存储:JSONL,一会话一文件([src/session.ts](../src/session.ts))

- **位置**:`.sessions/<id>.jsonl`(已加进 `.gitignore`)。
- **格式**:**每行一条 `Message`**,`append-only`(只追加、不重写)。
- **id**:`crypto.randomUUID()`;**元数据**(更新时间)直接用文件 mtime,不另存。

为什么是 JSONL 而不是单个 JSON,以及"本地文件 vs 数据库"的取舍,见文末「设计取舍」。

## 磁盘 = 完整流水,内存 = 截断工作集(关键)

这两者**有意分离**:

- **磁盘**:每轮成功后**追加本轮新增的几条消息**,永远保留**完整**对话;
- **内存**:`this.history` 仍会被第 4 步的 `compactHistory()` 按 token 预算**截断**。

因为我们"每轮成功后才追加"、且中断的轮会**封口成合法状态**再追加(见下),所以磁盘里永远是**只追加、不删除**的合法记录 —— JSONL 的追加/抗崩溃优势全拿到。续聊时把磁盘读回内存,再交给 compactHistory 按需截断。

## 怎么切分多轮?用"真实用户输入"做天然边界

JSONL 里**不需要分隔符**。约定:用户输入是**字符串** content,工具结果是 **`ContentBlock[]`** content。所以"`role==="user"` 且 content 是字符串"就是一轮的起点 —— 这正是 [context.ts](../src/context.ts) 截断逻辑用的同一个 `isUserInput` 规则,持久化这边直接复用。

> 业界更强的做法是给每条消息加 `uuid`/`parentUuid`/`timestamp`,靠父链重建轮次与分支(Claude Code 的 jsonl 即如此)。那能支持分支/时间线,但要把"一行一条原始 Message"升级成"带元数据的记录",对学习项目过重 → TODO。

## 何时写:onTurnComplete 钩子([src/agent.ts](../src/agent.ts))

Agent 与"文件怎么存"解耦:

- Agent 在 `send` 里用 `added` 数组收集本轮 push 进历史的消息,提交时触发 `onTurnComplete(added)`;
- CLI 把它接到 `appendMessages(sessionId, added)` 上 → 追加落盘;
- 新增 `loadHistory(messages)`,续聊时把磁盘历史灌进内存。

`onTurnComplete` 在**正常结束**和**中断封口**时都会触发 —— 这样被中断的轮也能落盘、可恢复。

## 中断的轮也能恢复:封口(修订第 7 步)

第 7 步原本是"中断 → 整轮回滚(丢弃)"。为了让中断的对话**也能恢复**,本步把它改成 **"封口成合法状态再保留/落盘"**(对齐 ChatGPT/DeepSeek 的"停止生成保留半截"):

| 中断时机 | 封口 |
|---|---|
| 流式输出文本中 | 已流出的**半截文本**存成 assistant 消息 |
| 工具执行中 | 给**未完成的** `tool_use` 补一条 `tool_result`(`is_error: true`, `"[已被用户中断]"`) |

给未完成工具补"取消结果"是**业界标准**(Anthropic API 要求每个 `tool_use` 必须配 `tool_result`,否则 400;Claude Code 的 `[Request interrupted by user]` 就是这个)。封口后历史**合法**,恢复后能**正常参与压缩**(和普通消息无异)。

## CLI 用法([src/cli.ts](../src/cli.ts))

- `bun run src/cli.ts` → 新建会话;
- `bun run src/cli.ts <sessionId>` → **续聊**该会话(打印"已恢复会话 …(N 条消息)");
- `/sessions` → 列出会话(id + 更新时间 + 首句摘要,标出当前);
- `/new` → 进程内开个新会话(换新 id、清空内存);
- 切换/删除/重命名 → TODO。

## 测试(`bun test`)

- [tests/session.test.ts](../tests/session.test.ts):`append → load` 往返(含内容块、跨两轮追加)、`listSessions` 摘要、空会话。(用临时目录 + `AGENT_SESSIONS_DIR` 覆盖,避免误删真实 `.sessions/`。)
- [tests/agent.test.ts](../tests/agent.test.ts):`onTurnComplete` 正常触发、`loadHistory` 恢复、**中断封口**两例(流式留半截文本 / 工具补取消结果)。

> 跨进程续聊用 PTY 验证过:进程 A 说"我叫张三"→退出→`cli.ts <id>` 重启→"已恢复会话(2 条消息)"→问名字→正确答出"张三"。

## 设计取舍:为什么 JSONL / 本地文件

- **JSONL vs 单 JSON**:追加 O(1)(不每轮重写整段)、抗崩溃(崩了只坏最后一行,单 JSON 会整文件解析失败)、业界惯例。
- **本地文件 vs 数据库**:本项目是单用户、单进程 CLI,没有跨会话查询/高并发多写/规模压力 → **append-only 文件 + 一会话一文件**正是这一档(零基础设施、抗崩溃、按会话独立生命周期、无锁)。若做成多租户云服务,才需要"一张表 + 索引"(跨用户查询、ACID、分页)。中间档是 SQLite(本地可查询但要引依赖,与"零依赖"冲突)。

## 留下的 TODO

1. 会话**切换/删除/重命名**、`--continue` 续最近;
2. 每条消息加 `timestamp`/`parentUuid` 等元数据,支持分支/时间线;
3. 超大会话**分段**(immutable segment,利于对象存储/上传);
4. JSONL 写入的并发/原子性加固(多进程写同一会话时)。

## 下一步

1. **摘要压缩**:上下文管理从"截断"升级为"先摘要再丢";
2. 多后端 LLM、子 agent、规划等进阶。
