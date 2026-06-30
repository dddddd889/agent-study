import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import {
  latestTodos,
  renderTodos,
  todoWriteTool,
  type Todo,
} from "../src/todo";
import type { LLMResponse, Message } from "../src/types";
import { FakeLLM } from "./fake-llm";

// 造一条「模型调用 todo_write」的 assistant 消息(全量清单作为入参)。
function todoCall(id: string, todos: Todo[]): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "todo_write", input: { todos } }],
  };
}

describe("latestTodos:从历史解析当前清单(单一真相 = history)", () => {
  test("没有任何 todo_write → 返回空", () => {
    const history: Message[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好" },
    ];
    expect(latestTodos(history)).toEqual([]);
  });

  test("多条 todo_write → 取最后一条", () => {
    const history: Message[] = [
      { role: "user", content: "干活" },
      todoCall("a", [
        { content: "A", status: "pending" },
        { content: "B", status: "pending" },
      ]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
      todoCall("b", [
        { content: "A", status: "completed" },
        { content: "B", status: "in_progress" },
      ]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "ok" }] },
    ];
    expect(latestTodos(history)).toEqual([
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ]);
  });

  test("忽略其它工具的调用,只认 todo_write", () => {
    const history: Message[] = [
      todoCall("t", [{ content: "唯一任务", status: "pending" }]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "shell", input: { cmd: "ls" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "..." }] },
    ];
    // 最后一条工具调用是 shell,但当前清单仍应来自那条 todo_write。
    expect(latestTodos(history)).toEqual([{ content: "唯一任务", status: "pending" }]);
  });

  test("脏数据宽松归一:非法 status → pending,空 content → 剔除", () => {
    const history: Message[] = [
      todoCall("d", [
        { content: "好任务", status: "weird" as Todo["status"] },
        { content: "", status: "pending" },
      ]),
    ];
    expect(latestTodos(history)).toEqual([{ content: "好任务", status: "pending" }]);
  });
});

describe("todo_write 工具:无状态 + 渲染", () => {
  test("run 把入参渲染成文本,且不依赖/不留外部状态", async () => {
    const todos: Todo[] = [
      { content: "读配置", status: "completed" },
      { content: "解析", status: "in_progress" },
      { content: "生成", status: "pending" },
    ];
    const out1 = await todoWriteTool.run({ todos });
    const out2 = await todoWriteTool.run({ todos }); // 同样入参 → 同样输出(无状态)
    expect(out1).toBe(out2);
    expect(out1).toContain("[x] 读配置");
    expect(out1).toContain("[→] 解析");
    expect(out1).toContain("[ ] 生成");

    // 换入参 → 输出只取决于本次入参,不受上一次调用影响。
    const out3 = await todoWriteTool.run({ todos: [{ content: "新", status: "pending" }] });
    expect(out3).toContain("[ ] 新");
    expect(out3).not.toContain("读配置");
  });

  test("todo_write 是非危险工具(不走审批)", () => {
    expect(todoWriteTool.dangerous).toBeFalsy();
  });

  test("renderTodos:空清单有占位文案", () => {
    expect(renderTodos([])).toContain("空");
  });
});

describe("续聊一致性:loadHistory 恢复后清单立刻正确(方案 B 的支点)", () => {
  test("把含 todo_write 的历史灌进 Agent → latestTodos 解析正确", () => {
    const restored: Message[] = [
      { role: "user", content: "继续上次的活" },
      todoCall("r", [
        { content: "第一步", status: "completed" },
        { content: "第二步", status: "in_progress" },
      ]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "ok" }] },
    ];
    const agent = new Agent(new FakeLLM(), {});
    agent.loadHistory(restored);
    // CLI 的 /todo 正是这样读:从 agent.getHistory() 解析,无第二真相。
    expect(latestTodos(agent.getHistory())).toEqual([
      { content: "第一步", status: "completed" },
      { content: "第二步", status: "in_progress" },
    ]);
  });
});

describe("辅助工具不计入 maxSteps 步数预算(auxiliary)", () => {
  // 一个最小的「干活」工具,用于占用步数预算。
  const realTool = {
    name: "real",
    description: "",
    inputSchema: { type: "object", properties: {} },
    run: () => "ok",
  };
  const call = (name: string, id: string): LLMResponse => ({
    stopReason: "tool_use",
    content: [{ type: "tool_use", id, name, input: name === "todo_write" ? { todos: [] } : {} }],
  });

  test("多次 todo_write 穿插不会顶爆预算:本会超的任务能完成", async () => {
    // 序列:todo, real, todo, real, todo, 文本。干活只有 2 步,但夹了 3 次 todo_write。
    const seq = ["todo_write", "real", "todo_write", "real", "todo_write"];
    let i = 0;
    const llm = new FakeLLM((): string | LLMResponse =>
      i < seq.length ? call(seq[i]!, `c${i++}`) : "全部完成",
    );
    // maxSteps=3:干活只 2 步,够用。但若 todo_write 也计入,5 轮里早在第 4 轮就抛错。
    const agent = new Agent(llm, { tools: [todoWriteTool, realTool], maxSteps: 3 });
    expect(await agent.send("活")).toBe("全部完成");
  });

  test("纯辅助工具空转 → 被硬上限(maxSteps×3)兜住,不会无限循环", async () => {
    // 模型只会不停调 todo_write,永不干活、永不给文本。
    let n = 0;
    const llm = new FakeLLM((): LLMResponse => call("todo_write", `t${n++}`));
    const agent = new Agent(llm, { tools: [todoWriteTool], maxSteps: 2 });
    // workSteps 永远不涨,但 hardLimit=6 会兜住并抛「超过最大步数」。
    await expect(agent.send("空转")).rejects.toThrow("超过最大工具调用步数");
    expect(n).toBeLessThanOrEqual(6); // 没有失控,迭代被硬上限挡住
  });
});

describe("集成:FakeLLM 脚本化一轮规划(先 todo_write,再答复)", () => {
  test("模型先调 todo_write 再给最终答复 → 历史累积 todo,/todo 能解析", async () => {
    let step = 0;
    const llm = new FakeLLM((): string | LLMResponse => {
      step++;
      if (step === 1) {
        // 第一步:模型决定拆任务,调 todo_write。
        return {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "p1",
              name: "todo_write",
              input: {
                todos: [
                  { content: "调研", status: "in_progress" },
                  { content: "实现", status: "pending" },
                ],
              },
            },
          ],
        };
      }
      // 第二步:看到工具结果后给最终答复。
      return "我已经把任务拆好了。";
    });

    const agent = new Agent(llm, { tools: [todoWriteTool] });
    const reply = await agent.send("帮我做个多步骤的活");
    expect(reply).toBe("我已经把任务拆好了。");

    // 历史里确实累积了 todo_write 调用 + 其结果。
    const history = agent.getHistory();
    const hasToolUse = history.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_use" && b.name === "todo_write"),
    );
    expect(hasToolUse).toBe(true);

    // /todo 的读取口径:从历史解析,拿到模型最后一次写的清单。
    expect(latestTodos(history)).toEqual([
      { content: "调研", status: "in_progress" },
      { content: "实现", status: "pending" },
    ]);
  });
});
