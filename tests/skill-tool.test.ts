import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import { createSkillTool, scanSkills } from "../src/skills";
import type { LLMResponse, Message, ToolResultBlock } from "../src/types";
import { FakeLLM } from "./fake-llm";

function makeSkill(root: string, name: string, frontmatter: string, body = "正文"): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`, "utf-8");
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "skill-tool-"));
  process.env.AGENT_SKILLS_DIR = projectRoot;
  process.env.AGENT_SKILLS_USER_DIR = join(projectRoot, "__no_user__");
});
afterEach(() => {
  delete process.env.AGENT_SKILLS_DIR;
  delete process.env.AGENT_SKILLS_USER_DIR;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("createSkillTool：菜单 + 派发", () => {
  test("菜单只列可模型调用的 skill(排除 disabled)", () => {
    makeSkill(projectRoot, "auto", "description: 自动技能");
    makeSkill(projectRoot, "manual", "description: 手动\ndisable-model-invocation: true");
    const tool = createSkillTool(scanSkills().skills)!;
    expect(tool.description).toContain("auto");
    expect(tool.description).toContain("自动技能");
    expect(tool.description).not.toContain("manual");
  });

  test("非危险(read) + 计一步干活(非 auxiliary)", () => {
    makeSkill(projectRoot, "auto", "description: d");
    const tool = createSkillTool(scanSkills().skills)!;
    expect(tool.category).toBe("read");
    expect(tool.auxiliary).toBeFalsy();
  });

  test("run 返回正文(含 Base directory + ARGUMENTS)", async () => {
    makeSkill(projectRoot, "auto", "description: d", "流程第一步");
    const tool = createSkillTool(scanSkills().skills)!;
    const out = String(await tool.run({ name: "auto", args: "目标X" }));
    expect(out).toContain("流程第一步");
    expect(out).toContain("Base directory for this skill:");
    expect(out).toContain("ARGUMENTS: 目标X");
  });

  test("未知 name → 抛错，错误里列可用项", async () => {
    makeSkill(projectRoot, "auto", "description: d");
    const tool = createSkillTool(scanSkills().skills)!;
    expect(() => tool.run({ name: "nope" })).toThrow(/未知 skill.*auto/);
  });

  test("disabled 的 skill 不可经模型通道调用(不在菜单 → 抛错)", async () => {
    makeSkill(projectRoot, "manual", "description: d\ndisable-model-invocation: true");
    const tool = createSkillTool(scanSkills().skills);
    // 全部 disabled → 没有可模型调用 skill → 不该暴露工具
    expect(tool).toBeNull();
  });

  test("无可模型调用 skill → createSkillTool 返回 null", () => {
    expect(createSkillTool([])).toBeNull();
  });
});

describe("agent 打标：模型通道 skill 结果块带 skillMark", () => {
  test("调 skill 成功 → tool_result 块 skillMark = skill 名；出错则不标", async () => {
    makeSkill(projectRoot, "auto", "description: d", "流程正文");
    const skillTool = createSkillTool(scanSkills().skills)!;

    // 脚本:第1轮调 skill(auto) → 第2轮调 skill(nope 未知) → 第3轮结束。
    let turn = 0;
    const llm = new FakeLLM((): string | LLMResponse => {
      turn++;
      if (turn === 1) {
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "s1", name: "skill", input: { name: "auto" } }],
        };
      }
      if (turn === 2) {
        return {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "s2", name: "skill", input: { name: "nope" } }],
        };
      }
      return "完成";
    });

    const agent = new Agent(llm, { tools: [skillTool], mode: "yolo" });
    await agent.send("用 auto 技能");
    const history = agent.getHistory();

    // 找出所有 tool_result 块。
    const results: ToolResultBlock[] = [];
    for (const m of history) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) if (b.type === "tool_result") results.push(b);
    }
    const ok = results.find((r) => r.tool_use_id === "s1")!;
    const bad = results.find((r) => r.tool_use_id === "s2")!;
    expect(ok.skillMark).toBe("auto"); // 成功正文 → 标记(存在历史/落盘)
    expect(ok.content).toContain("流程正文");
    expect(bad.is_error).toBe(true);
    expect(bad.skillMark).toBeUndefined(); // 出错无正文 → 不标

    // 线安全:发给 LLM 的消息里,tool_result 块【不得】带 skillMark(rehydrate 已剥掉),
    // 否则 Anthropic 可能因多余字段 400。
    for (const call of llm.calls) {
      for (const m of call.messages) {
        if (typeof m.content === "string") continue;
        for (const b of m.content) {
          if (b.type === "tool_result") {
            expect(b.skillMark).toBeUndefined();
          }
        }
      }
    }
  });
});
