# 第 14 步：规划 / 子任务分解（todo 清单）

> 前面的 agent 已经会调工具、会循环。但面对「多步骤」任务,它容易走着走着忘了整体计划、漏掉某一步。这一步给它一个**维护任务清单**的能力:把复杂目标拆成 todo、逐项跟踪进度。

## 核心洞察:规划不是「写一堆编排代码」

最反直觉的一点:**规划能力主要来自「一个记录任务的工具 + 一段系统提示」,而不是复杂的代码编排。**

模型本来就会拆解任务,它缺的只是一个「把计划写下来、并在执行中持续参照/更新」的地方。给它一个 `todo_write` 工具当这块「便签」,再用 system 提示引导它「多步任务先列清单、做完即勾掉」,规划就涌现了。所以这一步 **`Agent` 零改动** —— `todo_write` 就是个普通 `Tool`,走的还是第 2 步的工具循环。

## 两个关键设计

### 1. 全量重写(而非增量操作)

`todo_write` 每次接收**完整**清单,直接覆盖旧的:

```ts
type Todo = { content: string; status: "pending" | "in_progress" | "completed" };
// 入参: { todos: Todo[] }
```

对比「增量操作」(`add_todo` / `update_status(id,…)`):全量重写**没有 id、没有合并逻辑**,模型不会改漏一处导致前后矛盾,实现端只是覆盖。清单通常就几条,重发全表的 token 开销可忽略。这也是 Claude Code 的 `TodoWrite` 做法。

### 2. 无状态工具 + 单一真相在 history

这是本步最值得琢磨的决定。`todo_write` 工具**自己不存任何状态**:

- `run` 只把入参渲染成文本返回,这条文本作为 `tool_result` 留进对话历史;
- 「当前清单」= 历史里**最后一条 `todo_write` 的入参**,由 `latestTodos(history)` 从后往前扫一条解析出来。

```
todo_write v1: [ ] A  [ ] B  [ ] C      ← 第3条消息,永久不变
   ...干活...
todo_write v2: [x] A  [→] B  [ ] C      ← 第9条消息,永久不变
   ...干活...
todo_write v3: [x] A  [x] B  [→] C      ← 最新 = 当前清单
```

**像 git**:每次调用是一次 commit(append 一个新快照),当前状态 = 最新那条,旧快照永不修改 —— 和磁盘 JSONL 的 append-only(见 [docs/09](09-persistence.md))天然契合。

**为什么不用闭包持一份状态?** 闭包会变成「第二真相」,和 history 漂移:

| 场景 | 闭包持状态 | 无状态 + history |
|---|---|---|
| 续聊(`loadHistory` 恢复) | 闭包是空的 → `/todo` 显示空,但模型从 history 看到旧清单(**分裂**) | `latestTodos` 立刻解析正确 ✓ |
| `/reset`、`/new` | 要记得手动清闭包 | 清的是 history,清单自动跟着没 ✓ |
| 可观测(`/todo`) | 要给工具开 getter | 直接从 `agent.getHistory()` 解析 ✓ |

一句话:**让 todo 状态「寄生」在对话历史里,history 走到哪 todo 跟到哪**,没有第二个需要同步的副本。

## 模型怎么「看到」当前清单

靠 history 本身:每次 `todo_write` 的 `tool_result`(渲染好的清单)就留在上下文里,模型后续每轮都看得到。**不需要**往 `system` 动态注入 —— 而这正好绕开了一个现实约束:`Agent.system` 是构造时定死的,目前没有「每轮动态注入」的钩子。

## 引导模型去用它（[src/cli.ts](../src/cli.ts)）

规划成败的关键在这段 system 提示(`baseSystem` 末段):

> 处理需要多步骤的任务时,先用 `todo_write` 把目标拆成清单再动手;每开始一项就标 in_progress、做完立刻标 completed,同一时刻最多一项 in_progress;计划有变就重发完整清单。简单的一两步任务不必用。

几条规则取自 Claude Code `TodoWrite` 的精华(何时建、单个 in_progress、做完即更新、全量重写),又明确「简单任务不必用」避免它对「1+1」也建清单。

## 可观测:`/todo` 命令

```
你 > 请规划一个三步骤的任务……
  · 调用工具 todo_write({"todos":[…]})
  · todo_write 结果：todo 已更新：
      [ ] 读取 README 文件内容
      [ ] 总结 README 的核心要点
      [ ] 将总结内容写入 summary.txt
你 > /todo
[当前任务]
  [ ] 读取 README 文件内容
  [ ] 总结 README 的核心要点
  [ ] 将总结内容写入 summary.txt
```

`/todo` 和工具结果回显**共用 `renderTodos`**,且都从 history 解析 —— 印证「单一真相」:命令和模型看到的是同一份。

## 别让 todo 蚕食步数预算（`auxiliary`）

agent 循环有个 `maxSteps`（默认 10），本意是「防止模型反复调工具陷入死循环」的安全阀——**每次模型响应算一步**。引入 todo 后冒出一个坑:模型「每开始/完成一步都更新 todo」,而**每次 `todo_write` 也算一步**,于是步数预算被记账动作吃掉一半:

```
查日期 → write → read → shell → write → merge   = 6 步干活
   穿插 todo_write ×4（建清单 + 3 次更新）        = +4 步
                                          合计 10 步 → 正好撞满 maxSteps,
                                                       连最后的「标完成 + 总结」都挤不进去 → 报错
```

修法:给 `Tool` 加一个 **`auxiliary`** 标志(不硬编码工具名,保持 `Agent` 通用),`todo_write` 标上它。循环里**只有「调了非辅助工具」的轮才消耗预算**：

```ts
let workSteps = 0;
const hardLimit = this.maxSteps * 3;   // 防辅助工具空转死循环的硬上限
for (let iter = 0; iter < hardLimit && workSteps < this.maxSteps; iter++) {
  // ...调模型、执行工具...
  const didWork = toolUses.some((c) => !this.tools.find((t) => t.name === c.name)?.auxiliary);
  if (didWork) workSteps++;            // 纯 todo 轮不涨 workSteps
}
```

为什么还要 `hardLimit`:辅助工具不涨 `workSteps`,万一模型只会空调 `todo_write`,光靠它循环永不停 —— 用 `maxSteps×3` 的硬上限兜住。

**边界(重要):这只解决「todo 记账蚕食预算」,不解决「任务本身的干活步数 > maxSteps」。** 比如清单里有 15 条、每条都要调工具,那是 15 步干活 > 10,仍会超 —— 那是**任务规模**问题,不是记账问题。两条出路:① 调大 `maxSteps`(它本就该是「宁大勿小」的防失控阀,不该用来限制任务规模);② 把大任务拆给**子 agent**(下一步),每个子 agent 有自己独立的步数预算,主 agent 只协调。

## 测试（`bun test`，全程 `FakeLLM` 离线）

[tests/todo.test.ts](../tests/todo.test.ts):

- **`latestTodos` 纯函数**:无 todo_write→空、多条取最新、忽略其它工具、脏数据宽松归一;
- **工具无状态 + 渲染**:同入参同输出、换入参不受上次影响、三态符号、非危险工具;
- **续聊一致性**:`loadHistory` 灌入含 todo 的历史 → `latestTodos` 立刻正确(守护「方案 B」的支点);
- **集成一轮**:`FakeLLM` 脚本化「先 todo_write 再答复」,验证 history 累积 todo、`/todo` 能解析;
- **辅助工具不计入预算**:多次 `todo_write` 穿插不顶爆 `maxSteps`;纯辅助空转被硬上限(`maxSteps×3`)兜住、不会无限循环。

## 留下的 TODO

1. **动态注入当前 todo**(Claude Code 的更强做法):每轮把最新清单作为 system-reminder 注入,模型永远「眼前有清单」。要给 `Agent` 加「每轮动态注入」钩子,本步未做。
2. **压缩丢清单**:对话特别长时,早期 `todo_write` 的 `tool_result` 可能被摘要压缩掉(见 [docs/11](11-summarization-compaction.md));目前靠 system 提示「不确定就重发」兜底。可让压缩对 todo 特殊保留。
3. **嵌套子任务 / 依赖关系**:当前是扁平清单。

## 下一步

- **子 agent 隔离**:把某个独立子任务甩给一个**独立上下文**的子 agent 去跑、只收回结论 —— 本步「会拆任务」是它的前提。
- 之后才谈多 agent 通信。
