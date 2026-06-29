# 第 2 步：工具调用循环（Tool Use Loop）

> 上一步（[README](../README.md)）做的是「能记住上下文的多轮对话」——本质是个 chatbot。
> 这一步加上**工具调用循环**，让它从「聊天机器人」变成真正的 **agent**：模型能自己决定调用工具、拿到结果、再决定下一步，循环往复直到完成任务。

## 一句话概括这次改动

`Agent.send()` 从「一问一答」变成「一个循环」：

```
调模型 → 模型要用工具？
            ├─ 是 → 执行工具 → 把结果喂回历史 → 回到「调模型」
            └─ 否 → 这就是最终答复，返回
```

历史里会**完整累积每一步的 `tool_use` 和 `tool_result`**，所以模型在循环的每一步都"知道之前调了什么工具、拿到什么结果"。

## 对比：对话循环 vs agent 循环

第 1 步（一轮 = 一次模型调用）：

```
push 用户输入 → LLM.complete(history) → push 回复 → 返回
```

第 2 步（一轮 = 可能多次模型调用 + 多次工具执行）：

```
push 用户输入
  loop:
    res = LLM.complete(history, {system, tools})
    若 res 里没有 tool_use:
        push assistant(文本); 返回文本        ← 出口
    push assistant(含 tool_use 的内容块)
    对每个 tool_use:
        result = 执行对应工具(input)
        收集成 tool_result 块
    push user(tool_result 块数组)
  （回到 loop 顶部，模型这次能看到工具结果）
```

关键点：**工具结果是以 `user` 角色、`tool_result` 内容块的形式回传给模型的**，这是 Anthropic Messages API 的约定。

## 一次完整往返里 history 怎么变

以「(123 + 877) * 2 等于几」为例，`history` 依次变成：

| # | role | content |
|---|---|---|
| 1 | user | `"(123 + 877) * 2 等于几"` |
| 2 | assistant | `[{type:"tool_use", id:"t1", name:"calculator", input:{expression:"(123+877)*2"}}]` |
| 3 | user | `[{type:"tool_result", tool_use_id:"t1", content:"2000", is_error:false}]` |
| 4 | assistant | `"计算结果是 2000"` |

第 2 条产生后，循环没有结束（有 `tool_use`）；执行计算器得到 `2000` 写进第 3 条；再次调模型，模型看到结果后给出第 4 条纯文本，循环出口返回。

## 类型层的演进（[src/types.ts](../src/types.ts)）

为支持工具，消息内容从「纯字符串」升级为「内容块数组」：

- **`TextBlock`** `{type:"text", text}` —— 普通文本
- **`ToolUseBlock`** `{type:"tool_use", id, name, input}` —— 模型请求调用工具（出现在 assistant 消息里）
- **`ToolResultBlock`** `{type:"tool_result", tool_use_id, content, is_error?}` —— 工具结果（作为 user 消息回传）

```ts
export interface Message {
  role: Role;
  content: string | ContentBlock[]; // 纯文本仍可用字符串；涉及工具时用块数组
}
```

**工具定义** = 给模型看的「说明书」+ 本地执行逻辑：

```ts
export interface Tool {
  name: string;
  description: string;              // 写清"什么时候用它"，模型据此决定是否调用
  inputSchema: Record<string, unknown>; // JSON Schema，描述参数
  run(input: Record<string, unknown>): string | Promise<string>; // 本地执行
}
```

**LLM 接口**也升级了——单次回复不再只是字符串，需要 `stopReason` 来判断是否继续循环：

```ts
export interface LLMResponse {
  stopReason: string;     // "end_turn" | "tool_use" | ...
  content: ContentBlock[]; // 文本 + 可能的 tool_use
}
export interface LLM {
  complete(messages: Message[], opts?: { system?: string; tools?: Tool[] }): Promise<LLMResponse>;
}
```

> 兼容取舍：纯文本回复在 `history` 里仍存成 `string`（更直观、不破坏第 1 步的行为），只有涉及工具的那一步才存成内容块数组。

## 核心实现（[src/agent.ts](../src/agent.ts)）

```ts
async send(userInput: string): Promise<string> {
  this.history.push({ role: "user", content: userInput });

  for (let step = 0; step < this.maxSteps; step++) {
    const res = await this.llm.complete(this.history, {
      system: this.system,
      tools: this.tools,
    });

    const toolUses = res.content.filter((b) => b.type === "tool_use");

    // 没有工具调用 => 最终答复，出口
    if (toolUses.length === 0) {
      const text = this.extractText(res.content);
      this.history.push({ role: "assistant", content: text });
      return text;
    }

    // 有工具调用 => 完整存下含 tool_use 的内容块
    this.history.push({ role: "assistant", content: res.content });

    // 逐个执行，收集成一条 user 消息（tool_result 块）
    const results = [];
    for (const call of toolUses) {
      const { content, isError } = await this.runTool(call);
      results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
    }
    this.history.push({ role: "user", content: results });
    // 继续下一轮：模型这次能看到工具结果
  }

  throw new Error(`超过最大工具调用步数（${this.maxSteps}），可能陷入循环`);
}
```

### 三个稳健性设计

1. **`maxSteps`（默认 10）**：模型若反复要工具会陷入死循环，超过上限直接抛错。
2. **工具错误不中断对话**：`runTool` 捕获异常 / 未知工具，转成 `is_error: true` 的 `tool_result` 喂回模型，让它看到错误自行纠正，而不是抛断整轮对话。
3. **`onToolCall` / `onToolResult` 回调**：可选钩子，便于 CLI 等上层观察"正在调用什么工具、拿到什么结果"。

## 内置示例工具（[src/tools.ts](../src/tools.ts)）

- **`get_current_time`**：返回当前 ISO 时间。模型本身不知道"现在几点"，这类实时信息正适合用工具补足。
- **`calculator`**：四则运算，参数用**字符集白名单**校验（只允许数字和 `+ - * / ( ) .` 空格），杜绝任意代码执行。模型做多步算术容易出错，交给确定性代码更可靠。

`defaultTools` 把这两个打包，CLI 直接用。

## LLM 实现的改动（[src/llm.ts](../src/llm.ts)）

- 请求体新增 `tools` 字段：只把 `name / description / input_schema` 发给模型，本地的 `run` 不外发。
- 解析响应里的 `stop_reason` 和内容块（`text` / `tool_use`），打包成 `LLMResponse` 返回。
- `content` 透传：字符串或内容块数组（含 `tool_use` / `tool_result`）对 API 都合法。

## CLI 接入（[src/cli.ts](../src/cli.ts)）

把 `defaultTools` 传给 `Agent`，并用回调把工具调用过程打印出来：

```
你 > 请用计算器算 (123 + 877) * 2
  · 调用工具 calculator({"expression":"(123 + 877) * 2"})
  · calculator 结果：2000
AI > 计算结果是 2000。
```

## 测试（`bun test`）

工具循环用 `FakeLLM` 离线验证，覆盖：

- **正常往返**：模型请求工具 → 执行 → 结果喂回 → 得到最终答复；并断言 `history` 的四条结构和"第二次调模型能看到工具结果"。
- **未知工具**：返回 `is_error` 结果块。
- **工具抛错**：被捕获成 `is_error`，对话不中断。
- **`maxSteps` 保护**：模型一直要工具时按上限抛错。
- **回调触发**：`onToolCall` / `onToolResult` 按序被调用。

`FakeLLM` 升级为：responder 既能返回完整 `LLMResponse`（演练工具调用），也能图省事直接返回字符串（当作 end_turn 纯文本）。

```bash
bun test          # 16 个用例全部离线通过
bun run typecheck # tsc 类型检查
```

## 下一步

1. **流式输出（SSE）**：边生成边显示，工具调用过程实时可见。
2. **上下文管理**：token 计数、历史过长时截断 / 摘要。
3. **更多工具**：读写文件、HTTP、shell —— 真正能干活。
4. **持久化**：把 `history` 存盘，跨进程续聊。
