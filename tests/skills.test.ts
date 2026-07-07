import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillBody, scanSkills, type SkillMeta } from "../src/skills";

// 造一个 skill 目录：<root>/<name>/SKILL.md，内容为 frontmatter + body。
function makeSkill(root: string, name: string, frontmatter: string, body = "正文内容"): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`, "utf-8");
}

let projectRoot: string;
let userRoot: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "skills-test-"));
  projectRoot = join(base, "project");
  userRoot = join(base, "user");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  process.env.AGENT_SKILLS_DIR = projectRoot;
  process.env.AGENT_SKILLS_USER_DIR = userRoot;
});

afterEach(() => {
  delete process.env.AGENT_SKILLS_DIR;
  delete process.env.AGENT_SKILLS_USER_DIR;
  rmSync(join(projectRoot, ".."), { recursive: true, force: true });
});

const byName = (skills: SkillMeta[]) => new Map(skills.map((s) => [s.name, s]));

describe("scanSkills：双源扫描 + 项目覆盖用户", () => {
  test("扫到项目级与用户级两处", () => {
    makeSkill(projectRoot, "code-review", "description: 审查代码");
    makeSkill(userRoot, "my-flow", "description: 个人流程");
    const { skills } = scanSkills();
    const m = byName(skills);
    expect(m.get("code-review")?.source).toBe("project");
    expect(m.get("my-flow")?.source).toBe("user");
  });

  test("同名时项目级覆盖用户级(含一条覆盖 warning)", () => {
    makeSkill(userRoot, "dup", "description: 用户版");
    makeSkill(projectRoot, "dup", "description: 项目版");
    const { skills, warnings } = scanSkills();
    const m = byName(skills);
    expect(m.get("dup")?.source).toBe("project");
    expect(m.get("dup")?.description).toBe("项目版");
    expect(warnings.some((w) => w.includes("dup") && w.includes("覆盖"))).toBe(true);
  });

  test("name 恒等于目录名(frontmatter 里写了别的 name 也无视)", () => {
    makeSkill(projectRoot, "real-name", "name: fake-name\ndescription: 测试");
    const { skills } = scanSkills();
    expect(skills[0]?.name).toBe("real-name");
  });

  test("disable-model-invocation: true 正确解析", () => {
    makeSkill(projectRoot, "manual-only", "description: 仅手动\ndisable-model-invocation: true");
    makeSkill(projectRoot, "auto-ok", "description: 自动");
    const m = byName(scanSkills().skills);
    expect(m.get("manual-only")?.disableModelInvocation).toBe(true);
    expect(m.get("auto-ok")?.disableModelInvocation).toBe(false);
  });
});

describe("scanSkills：加载软失败(跳过 + warning，不抛)", () => {
  test("四类坏 skill 各被跳过并各产 warning，好 skill 不受影响", () => {
    makeSkill(projectRoot, "good", "description: 好的");
    makeSkill(projectRoot, "no-desc", "name: x"); // 缺 description
    // 坏 frontmatter：没有闭合 ---
    const badDir = join(projectRoot, "bad-fm");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "SKILL.md"), "没有 frontmatter 边界\n正文", "utf-8");
    // 非法目录名
    makeSkill(projectRoot, "Bad_Name", "description: 非法名");
    // 无 SKILL.md 的空目录
    mkdirSync(join(projectRoot, "empty-dir"), { recursive: true });

    const { skills, warnings } = scanSkills();
    const m = byName(skills);
    expect(m.has("good")).toBe(true);
    expect(m.has("no-desc")).toBe(false);
    expect(m.has("bad-fm")).toBe(false);
    expect(m.has("Bad_Name")).toBe(false);
    expect(m.has("empty-dir")).toBe(false);
    // 四类坏各至少一条 warning
    expect(warnings.some((w) => w.includes("no-desc") && w.includes("description"))).toBe(true);
    expect(warnings.some((w) => w.includes("bad-fm"))).toBe(true);
    expect(warnings.some((w) => w.includes("Bad_Name"))).toBe(true);
    expect(warnings.some((w) => w.includes("empty-dir") && w.includes("SKILL.md"))).toBe(true);
  });

  test("目录都不存在 → 空菜单、不抛", () => {
    process.env.AGENT_SKILLS_DIR = join(projectRoot, "nonexistent");
    process.env.AGENT_SKILLS_USER_DIR = join(userRoot, "nonexistent");
    const { skills, warnings } = scanSkills();
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("loadSkillBody：现读正文 + 拼装", () => {
  test("剥除 frontmatter，顶部有 Base directory 行", () => {
    makeSkill(projectRoot, "s", "description: d", "这是流程正文");
    const meta = byName(scanSkills().skills).get("s")!;
    const out = loadSkillBody(meta);
    expect(out).toContain("这是流程正文");
    expect(out).not.toContain("description: d");
    expect(out.startsWith(`Base directory for this skill: ${meta.dir}`)).toBe(true);
  });

  test("给 args 时尾部有 ARGUMENTS 行，不给则无", () => {
    makeSkill(projectRoot, "s", "description: d", "正文");
    const meta = byName(scanSkills().skills).get("s")!;
    expect(loadSkillBody(meta, "支持 skill 能力")).toContain("ARGUMENTS: 支持 skill 能力");
    expect(loadSkillBody(meta)).not.toContain("ARGUMENTS:");
  });

  test("正文热：改 SKILL.md 后 loadSkillBody 立即反映新内容", () => {
    makeSkill(projectRoot, "s", "description: d", "旧正文");
    const meta = byName(scanSkills().skills).get("s")!;
    makeSkill(projectRoot, "s", "description: d", "新正文");
    expect(loadSkillBody(meta)).toContain("新正文");
  });

  test("正文里以 --- 开头的行不会截断 frontmatter", () => {
    makeSkill(projectRoot, "s", "description: 有分隔符的技能", "第一段\n---\n第二段");
    const m = byName(scanSkills().skills).get("s")!;
    expect(m.description).toBe("有分隔符的技能");
    const body = loadSkillBody(m);
    expect(body).toContain("第一段");
    expect(body).toContain("第二段"); // 正文里的 --- 之后内容不丢
  });
});
