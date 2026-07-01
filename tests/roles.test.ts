import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import { ROLES } from "../src/roles";
import {
  createCriticTool,
  createDispatchAgentTool,
  CRITIC_TOOL_NAME,
  DISPATCH_TOOL_NAME,
  SUBAGENT_SYSTEM,
} from "../src/subagent";
import { defaultTools } from "../src/tools";
import type { LLMResponse, Tool } from "../src/types";
import { FakeLLM } from "./fake-llm";

const TMP = mkdtempSync(join(tmpdir(), "roles-test-"));
process.env.AGENT_SESSIONS_DIR = TMP;
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// 主 agent 无 system;子 agent 带角色 system。据此在 FakeLLM 里区分「这次是子 agent」。
// 脚本:主 agent 第一次派活(带指定 agent_type),子 agent 直接给结论。
function runWith(agentType: string | undefined, sessionId: string) {
  const llm = new FakeLLM((messages, opts): string | LLMResponse => {
    if (opts.system) return "子结论"; // 任意子 agent
    const done = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    if (done) return "主答复";
    const input: Record<string, unknown> = { prompt: "干点活" };
    if (agentType !== undefined) input.agent_type = agentType;
    return {
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "d1", name: DISPATCH_TOOL_NAME, input }],
    };
  });

  let dispatchTool: Tool;
  let criticTool: Tool;
  const getTools = () => [dispatchTool, criticTool, ...defaultTools];
  const deps = { llm, getTools, getSessionId: () => sessionId };
  dispatchTool = createDispatchAgentTool(deps);
  criticTool = createCriticTool(deps);
  const agent = new Agent(llm, { tools: [dispatchTool, criticTool, ...defaultTools] });
  return { llm, agent };
}

// 拿到子 agent 那次调用(第一个带 system 的)。
const subCall = (llm: FakeLLM) => llm.calls.find((c) => c.system)!;
const toolNames = (llm: FakeLLM) => (subCall(llm).tools ?? []).map((t) => t.name);

describe("dispatch_agent 的 agent_type 角色注册表", () => {
  test("agent_type=explore → 用 explore 的 system + 只读工具(去 write_file)", async () => {
    const { llm, agent } = runWith("explore", "sess-explore");
    await agent.send("go");
    expect(subCall(llm).system).toBe(ROLES.explore!.system);
    const names = toolNames(llm);
    expect(names).toContain("read_file"); // 只读探索仍能读
    expect(names).toContain("shell");
    expect(names).not.toContain("write_file"); // explore 剔除写
  });

  test("不填 agent_type → 默认 general(system=通用,保留 write_file)", async () => {
    const { llm, agent } = runWith(undefined, "sess-default");
    await agent.send("go");
    expect(subCall(llm).system).toBe(SUBAGENT_SYSTEM); // = general 的 system
    expect(toolNames(llm)).toContain("write_file"); // general 不额外剔除
  });

  test("非法 agent_type → 宽松回退 general", async () => {
    const { llm, agent } = runWith("nonesuch", "sess-bad");
    await agent.send("go");
    expect(subCall(llm).system).toBe(SUBAGENT_SYSTEM);
  });

  test("禁嵌套基线:任何子 agent 工具集都不含 dispatch_agent 和 critic", async () => {
    const { llm, agent } = runWith(undefined, "sess-nesting");
    await agent.send("go");
    const names = toolNames(llm);
    expect(names).not.toContain(DISPATCH_TOOL_NAME); // 不能再派子 agent
    expect(names).not.toContain(CRITIC_TOOL_NAME); // 也不能请 critic(第17步漏修的隐患)
  });
});
