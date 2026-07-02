import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import {
  initialMode,
  isPermissionMode,
  MODES,
  modeSystemLine,
  resolvePolicy,
} from "../src/permission";
import { createDispatchAgentTool, DISPATCH_TOOL_NAME } from "../src/subagent";
import type { LLMResponse, Message, Tool } from "../src/types";
import { FakeLLM } from "./fake-llm";

// 子 agent 存档落到临时目录,别污染仓库 .sessions。
const TMP = mkdtempSync(join(tmpdir(), "perm-test-"));
process.env.AGENT_SESSIONS_DIR = TMP;
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ============ 单元:permission 表与解析 ============
describe("权限模式:策略表", () => {
  test("resolvePolicy 覆盖四档 × 三类", () => {
    // default:读放行,改/执行都问
    expect(resolvePolicy("default", "read")).toBe("allow");
    expect(resolvePolicy("default", "edit")).toBe("ask");
    expect(resolvePolicy("default", "exec")).toBe("ask");
    // acceptEdits:改自动,执行仍问
    expect(resolvePolicy("acceptEdits", "edit")).toBe("allow");
    expect(resolvePolicy("acceptEdits", "exec")).toBe("ask");
    // plan:改/执行一律拒
    expect(resolvePolicy("plan", "edit")).toBe("deny");
    expect(resolvePolicy("plan", "exec")).toBe("deny");
    expect(resolvePolicy("plan", "read")).toBe("allow");
    // yolo:全放行
    expect(resolvePolicy("yolo", "edit")).toBe("allow");
    expect(resolvePolicy("yolo", "exec")).toBe("allow");
  });

  test("类别缺省按 read(无副作用兜底)", () => {
    expect(resolvePolicy("plan")).toBe("allow"); // 不传类别 = read
    // 所有模式的 read 都是 allow(只读操作各档均放行)
    for (const m of Object.keys(MODES) as (keyof typeof MODES)[]) {
      expect(MODES[m].read).toBe("allow");
    }
  });

  test("isPermissionMode 只认四个合法名", () => {
    expect(isPermissionMode("plan")).toBe(true);
    expect(isPermissionMode("yolo")).toBe(true);
    expect(isPermissionMode("nonesuch")).toBe(false);
  });

  test("initialMode 读 AGENT_MODE,非法回退 default", () => {
    const saved = process.env.AGENT_MODE;
    try {
      process.env.AGENT_MODE = "plan";
      expect(initialMode()).toBe("plan");
      process.env.AGENT_MODE = "garbage";
      expect(initialMode()).toBe("default");
      delete process.env.AGENT_MODE;
      expect(initialMode()).toBe("default");
    } finally {
      if (saved === undefined) delete process.env.AGENT_MODE;
      else process.env.AGENT_MODE = saved;
    }
  });

  test("modeSystemLine:default 不注入,plan 给主动规划指令", () => {
    expect(modeSystemLine("default")).toBe(""); // 基线,不注入
    expect(modeSystemLine("plan")).toContain("plan");
    expect(modeSystemLine("plan")).toContain("/mode acceptEdits");
    expect(modeSystemLine("acceptEdits")).toContain("acceptEdits");
  });
});

// ============ 集成:Agent 按模式放行/询问/拒绝 ============
// 一步要某工具、下一步收尾的假 LLM(跨多次 send 也成立:只要上一条不是 tool_result 就再要一次)。
function wantTool(toolName: string): FakeLLM {
  return new FakeLLM((messages): string | LLMResponse => {
    const last = messages[messages.length - 1];
    const isResult =
      Array.isArray(last?.content) &&
      last.content.some((b) => b.type === "tool_result");
    if (isResult) return "完成";
    return {
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: toolName, input: {} }],
    };
  });
}

// 造一个指定类别的工具,run 时记一笔(便于断言「跑没跑」)。
function makeTool(name: string, category: Tool["category"], ran: string[]): Tool {
  return {
    name,
    description: "测试工具",
    category,
    inputSchema: { type: "object", properties: {} },
    run: () => {
      ran.push(name);
      return "ok";
    },
  };
}

describe("权限模式:Agent 决策", () => {
  test("plan:edit 被硬拒(不问、不跑,回带原因的 is_error)", async () => {
    const ran: string[] = [];
    let approvals = 0;
    const agent = new Agent(wantTool("edit_x"), {
      mode: "plan",
      tools: [makeTool("edit_x", "edit", ran)],
      onApprove: async () => (approvals++, "once"),
    });
    await agent.send("go");
    expect(ran).toHaveLength(0); // 没执行
    expect(approvals).toBe(0); // deny 不弹问
    const res = agent.getHistory()[2]!.content as Array<{
      is_error?: boolean;
      content: string;
    }>;
    expect(res[0]!.is_error).toBe(true);
    expect(res[0]!.content).toContain("plan");
  });

  test("plan:read 仍放行(只读探查)", async () => {
    const ran: string[] = [];
    let approvals = 0;
    const agent = new Agent(wantTool("read_x"), {
      mode: "plan",
      tools: [makeTool("read_x", "read", ran)],
      onApprove: async () => (approvals++, "once"),
    });
    await agent.send("go");
    expect(ran).toEqual(["read_x"]);
    expect(approvals).toBe(0);
  });

  test("acceptEdits:edit 自动放行(不问)、exec 仍要问", async () => {
    const ranE: string[] = [];
    let apE = 0;
    await new Agent(wantTool("edit_x"), {
      mode: "acceptEdits",
      tools: [makeTool("edit_x", "edit", ranE)],
      onApprove: async () => (apE++, "once"),
    }).send("go");
    expect(ranE).toEqual(["edit_x"]);
    expect(apE).toBe(0); // 编辑不问

    const ranX: string[] = [];
    let apX = 0;
    await new Agent(wantTool("exec_x"), {
      mode: "acceptEdits",
      tools: [makeTool("exec_x", "exec", ranX)],
      onApprove: async () => (apX++, "once"),
    }).send("go");
    expect(ranX).toEqual(["exec_x"]);
    expect(apX).toBe(1); // 执行仍问
  });

  test("default:edit 要问(修正:read 不再问,见只读用例)", async () => {
    const ran: string[] = [];
    let approvals = 0;
    await new Agent(wantTool("edit_x"), {
      mode: "default",
      tools: [makeTool("edit_x", "edit", ran)],
      onApprove: async () => (approvals++, "once"),
    }).send("go");
    expect(approvals).toBe(1);
    expect(ran).toEqual(["edit_x"]);
  });

  test("yolo:exec 也自动放行(不问)", async () => {
    const ran: string[] = [];
    let approvals = 0;
    await new Agent(wantTool("exec_x"), {
      mode: "yolo",
      tools: [makeTool("exec_x", "exec", ran)],
      onApprove: async () => (approvals++, "once"),
    }).send("go");
    expect(ran).toEqual(["exec_x"]);
    expect(approvals).toBe(0);
  });

  test("deny > always:default 选过总是,切 plan 后仍被硬拒", async () => {
    const ran: string[] = [];
    let approvals = 0;
    const agent = new Agent(wantTool("edit_x"), {
      mode: "default",
      tools: [makeTool("edit_x", "edit", ran)],
      onApprove: async () => (approvals++, "always"),
    });
    await agent.send("go1"); // default:问一次、选总是、执行
    expect(approvals).toBe(1);
    expect(ran).toEqual(["edit_x"]);

    agent.setMode("plan");
    await agent.send("go2"); // plan:无视「总是」,硬拒
    expect(approvals).toBe(1); // 没再问
    expect(ran).toEqual(["edit_x"]); // 第二次没跑
  });

  test("setMode / getMode 运行时切换", () => {
    const agent = new Agent(new FakeLLM(), { mode: "default" });
    expect(agent.getMode()).toBe("default");
    agent.setMode("acceptEdits");
    expect(agent.getMode()).toBe("acceptEdits");
  });
});

// ============ 集成:system 注入 ============
describe("权限模式:system 注入", () => {
  test("default 不注入(system 原样)", async () => {
    const llm = new FakeLLM(() => "hi");
    await new Agent(llm, { system: "BASE", mode: "default" }).send("x");
    expect(llm.calls[0]!.system).toBe("BASE");
  });

  test("plan 追加模式说明行", async () => {
    const llm = new FakeLLM(() => "hi");
    await new Agent(llm, { system: "BASE", mode: "plan" }).send("x");
    expect(llm.calls[0]!.system).toContain("BASE");
    expect(llm.calls[0]!.system).toContain("plan");
  });
});

// ============ 集成:子 agent 继承主 agent 模式 ============
describe("权限模式:子 agent 继承", () => {
  test("plan 下派活,子 agent 的 edit 也被硬拒", async () => {
    const ran: string[] = [];
    let approvals = 0;
    const editTool = makeTool("edit_x", "edit", ran);
    const llm = new FakeLLM((messages, opts): string | LLMResponse => {
      if (opts.system) {
        // 子 agent:先要 edit,收到结果(应是 deny 的 is_error)后收尾。
        const last = messages[messages.length - 1];
        const isResult =
          Array.isArray(last?.content) &&
          last.content.some((b: { type: string }) => b.type === "tool_result");
        if (isResult) return "子完成";
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "s1", name: "edit_x", input: {} }],
        };
      }
      // 主 agent:派一个 general 子 agent,收到结论后收尾。
      const done = messages.some(
        (m: Message) =>
          Array.isArray(m.content) &&
          m.content.some((b: { type: string }) => b.type === "tool_result"),
      );
      if (done) return "主答复";
      return {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "d1",
            name: DISPATCH_TOOL_NAME,
            input: { prompt: "干活" },
          },
        ],
      };
    });

    let dispatchTool: Tool;
    const getTools = () => [dispatchTool, editTool];
    const deps = {
      llm,
      getTools,
      getSessionId: () => "sess-perm",
      onApprove: async () => (approvals++, "once" as const),
      getMode: () => "plan" as const, // 子 agent 继承 plan
    };
    dispatchTool = createDispatchAgentTool(deps);

    const agent = new Agent(llm, {
      mode: "plan",
      tools: [dispatchTool, editTool],
      onApprove: async () => (approvals++, "once"),
    });
    await agent.send("go");
    expect(ran).toHaveLength(0); // 子 agent 的 edit 被 plan 拒,没跑
    expect(approvals).toBe(0); // deny 不问
  });
});
