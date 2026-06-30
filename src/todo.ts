import type { Message, Tool, ToolUseBlock } from "./types";

// 第 14 步:任务规划 / 子任务分解 —— 给模型一个维护 todo 清单的工具。
//
// 核心洞察:规划能力主要来自「一个记录任务的工具 + 系统提示引导」,
// 而不是复杂的代码编排。Agent 完全不用改 —— todo_write 就是个普通 Tool。
//
// 两个关键设计(详见 docs/14):
//   1. 全量重写:每次传【完整】清单,直接覆盖。无 id、无增量合并,模型不会改漏、
//      状态不会前后矛盾。就是 Claude Code 的 TodoWrite 做法。
//   2. 无状态 + 单一真相在 history:工具自己【不存任何东西】。每次调用产生一条
//      tool_use(含完整 todos),append 进对话历史(也随之 JSONL 落盘)。
//      「当前清单」= 历史里最后一条 todo_write 的入参(latestTodos 解析)。
//      —— 像 git:每次调用是一次 commit(新快照),当前状态 = 最新那条,旧的不改。
//      好处:续聊恢复 history 后清单天然正确,不存在「闭包第二真相」与历史漂移。

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo {
  content: string;
  status: TodoStatus;
}

export const TODO_TOOL_NAME = "todo_write";

// 三态渲染成带标记的多行文本。/todo 命令与工具结果回显共用,保证「看到的是同一份」。
const MARK: Record<TodoStatus, string> = {
  completed: "[x]",
  in_progress: "[→]",
  pending: "[ ]",
};
export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return "（清单为空）";
  return todos.map((t) => `  ${MARK[t.status] ?? "[ ]"} ${t.content}`).join("\n");
}

// 宽松校验模型给的 todos:丢掉结构不对的项,status 不合法的归一为 pending、
// content 为空的剔除。模型偶尔给脏数据也不至于崩。
function normalizeTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return [];
  const valid: TodoStatus[] = ["pending", "in_progress", "completed"];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => {
      const status = t.status;
      return {
        content: String(t.content ?? ""),
        status: (valid as unknown[]).includes(status)
          ? (status as TodoStatus)
          : "pending",
      };
    })
    .filter((t) => t.content);
}

// 从历史里解析「当前清单」:从后往前找第一条 todo_write 的 tool_use,取它的 todos。
// 没有任何 todo_write → 返回空数组。这是 todo 状态唯一的读取口径(单一真相 = history)。
export function latestTodos(history: Message[]): Todo[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use" && block.name === TODO_TOOL_NAME) {
        return normalizeTodos((block as ToolUseBlock).input?.todos);
      }
    }
  }
  return [];
}

// todo_write 工具:无状态。run 只把入参渲染成文本返回,这条文本会作为 tool_result
// 留进 history,模型后续每轮都能看到当前清单(不需要往 system 动态注入)。
export const todoWriteTool: Tool = {
  name: TODO_TOOL_NAME,
  description:
    "维护任务清单。处理多步任务时用它拆解、跟踪进度。每次传【完整】清单(全量覆盖旧清单)。" +
    "status: pending(待办) / in_progress(进行中) / completed(已完成)。",
  dangerous: false, // 纯记录,不碰文件/网络/进程,无需人工确认
  auxiliary: true, // 记账工具,不计入 maxSteps 干活步数预算(见 agent.ts 循环 / docs/14)
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整的任务清单(全量覆盖旧清单)",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "任务描述" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "任务状态",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  run: (input) => {
    const todos = normalizeTodos(input.todos);
    return `todo 已更新：\n${renderTodos(todos)}`;
  },
};
