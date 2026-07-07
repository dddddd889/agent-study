import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool } from "./types";

// Skill：按需加载、注入【当前 agent 上下文】、模型可自主选用(也可用户 /<name> 手动)的指令/流程包。
// 见 CONTEXT.md「Skill 能力」、docs/adr/0014。
//
// 本模块是 skill 的全部领域逻辑，离线可测：扫两处目录、只解析 frontmatter 建菜单、按名定位、
// 调用时现读正文并拼装。不碰 agent / cli / tools。新建模块而非塞进 roles.ts —— skill ≠ 角色
// (一个在当前上下文注指令、一个是隔离子 agent 的人格 + 裁工具)。

// 一条 skill 的菜单条目(不含正文——正文按需在 loadSkillBody 时才读，即「正文热、菜单冷」)。
export interface SkillMeta {
  name: string; // 以【目录名】为准(单一真相);frontmatter 里的 name 被忽略
  description: string; // 菜单文案 + 模型选用依据(必填)
  disableModelInvocation: boolean; // true = 仅用户 /<name> 可调、不进模型菜单
  source: "project" | "user"; // 来源，供 /skills 展示与「项目覆盖用户」
  dir: string; // skill 目录的绝对路径(loadSkillBody 现读 SKILL.md + Base directory 行的锚点)
}

// 合法 skill 名(要能当 /<name> 用):kebab-case，字母/数字/连字符，字母数字开头。
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// 基础配置目录名，默认 `.claude`（对标 Claude Code），由 AGENT_CONFIG_DIR 覆盖。
// 做成变量而非硬编码：需要避开与【真 Claude Code】互相加载/污染时，改这一个 env 即可
// （如 AGENT_CONFIG_DIR=.agent → skill 从 .agent/skills 加载）。将来的自定义命令/角色也可挂这里。
function configDir(): string {
  return process.env.AGENT_CONFIG_DIR ?? ".claude";
}

// 项目级 skill 根目录，默认 <configDir>/skills。AGENT_SKILLS_DIR 可给完整路径直接覆盖(测试隔离)。
function projectSkillsDir(): string {
  return process.env.AGENT_SKILLS_DIR ?? join(configDir(), "skills");
}

// 用户级 skill 根目录，默认 ~/<configDir>/skills。AGENT_SKILLS_USER_DIR 可给完整路径覆盖(测试隔离)。
function userSkillsDir(): string {
  return process.env.AGENT_SKILLS_USER_DIR ?? join(homedir(), configDir(), "skills");
}

// 极小 frontmatter 解析(零依赖，与仓库「零运行时依赖」一致)：
// 认开头的 `---\n ... \n---`，逐行 `key: value`。只取本模块用到的 description /
// disable-model-invocation;其余键忽略。返回 null 表示没有合法 frontmatter 边界。
function parseFrontmatter(
  raw: string,
): { data: Record<string, string>; body: string } | null {
  // 统一换行，容忍 BOM / 前导空行。
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const rest = text.slice(4);
  // 闭合的 --- 必须【独占一行】(容忍行尾空白):匹配 \n--- 后紧跟换行或文件结尾。
  // 这样正文里某行以 --- 开头(如 YAML 文档分隔)不会把 frontmatter 提前截断。
  const close = /\n---[ \t]*(\n|$)/.exec(rest);
  if (!close) return null;
  const fmBlock = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);

  const data: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // 去掉成对引号。
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body };
}

// 扫一个根目录下的所有 skill 子目录。逐目录软失败：坏 skill 只跳过 + 记一条 warning，绝不抛。
function scanDir(
  root: string,
  source: "project" | "user",
  out: Map<string, SkillMeta>,
  warnings: string[],
): void {
  if (!existsSync(root)) return; // 目录不存在是常态，静默
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // 读不动根目录：静默跳过整个来源
  }
  for (const name of entries) {
    const dir = resolve(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue; // 只认目录式
    } catch {
      continue;
    }
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      warnings.push(`skill "${name}"：缺 SKILL.md，已跳过`);
      continue;
    }
    if (!NAME_RE.test(name)) {
      warnings.push(`skill "${name}"：目录名不是合法命令 token(建议 kebab-case)，已跳过`);
      continue;
    }
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(readFileSync(file, "utf-8"));
    } catch {
      warnings.push(`skill "${name}"：SKILL.md 读取失败，已跳过`);
      continue;
    }
    if (!parsed) {
      warnings.push(`skill "${name}"：frontmatter 缺失或格式错误，已跳过`);
      continue;
    }
    const description = (parsed.data.description ?? "").trim();
    if (!description) {
      warnings.push(`skill "${name}"：frontmatter 缺 description，已跳过`);
      continue;
    }
    const disableModelInvocation = parsed.data["disable-model-invocation"] === "true";
    // 「项目覆盖用户」：项目级后扫，Map.set 直接覆盖同名用户级条目。
    if (out.has(name) && source === "project") {
      warnings.push(`skill "${name}"：用户级被项目级覆盖`);
    }
    out.set(name, { name, description, disableModelInvocation, source, dir });
  }
}

// 扫两处目录(用户级先、项目级后)，只解析 frontmatter 建菜单。同名项目覆盖用户。
// 返回菜单 + warnings —— 由上层(CLI)决定怎么显示，本模块不打印。
export function scanSkills(): { skills: SkillMeta[]; warnings: string[] } {
  const out = new Map<string, SkillMeta>();
  const warnings: string[] = [];
  // 用户级先扫，项目级后扫覆盖。
  scanDir(userSkillsDir(), "user", out, warnings);
  scanDir(projectSkillsDir(), "project", out, warnings);
  return { skills: [...out.values()], warnings };
}

// 调用时【现读】正文并拼装(即「正文热」——改正文立即生效，无需 reload)。
//   · 剥掉 frontmatter，取正文;
//   · 顶部加一行 `Base directory for this skill: <abs>` —— 给正文里的相对引用一个锚点
//     (正文引导模型 read_file 同目录资源时据此定位，见 ADR-0014「资源范围」);
//   · 若有 args，尾部加 `ARGUMENTS: <args>`。
export function loadSkillBody(meta: SkillMeta, args?: string): string {
  const file = join(meta.dir, "SKILL.md");
  const parsed = parseFrontmatter(readFileSync(file, "utf-8"));
  const body = (parsed?.body ?? "").trim();
  const parts = [`Base directory for this skill: ${meta.dir}`, "", body];
  if (args && args.trim() !== "") parts.push("", `ARGUMENTS: ${args.trim()}`);
  return parts.join("\n");
}

// skill 工具名。agent.ts 据此识别「这次工具调用是 skill」并给结果打块级标记(见 execOne)。
export const SKILL_TOOL_NAME = "skill";

// 模型通道可调用的 skill(排除 disable-model-invocation 的——那些只走用户 /<name>)。
export function modelInvocableSkills(skills: SkillMeta[]): SkillMeta[] {
  return skills.filter((s) => !s.disableModelInvocation);
}

// 单一 `skill` 工具(名字派发) —— 模型通道触发一个 skill。见 docs/adr/0014「调用」。
// 菜单(name+description)枚举进工具 description,吃提示词缓存前缀(渐进披露的廉价那一半);
// 正文按需在 run 里现读(「正文热」)。工厂式(对标 subagent.ts 的 createDispatchAgentTool):
// skill 集是运行时数据(可 /skills reload),故闭包持有本次快照。
//   · 非危险(category:read):本身只读 md 并注入文本,真副作用在正文引导模型后续调的工具上,
//     它们各自该确认时自会确认(对齐 dispatch_agent)。
//   · 计一步干活(非 auxiliary):调 skill 是实质推进动作。
// 返回 null 表示【没有可模型调用的 skill】—— 此时不该给模型一个没得选的工具(由 CLI 决定不挂)。
export function createSkillTool(skills: SkillMeta[]): Tool | null {
  const menu = modelInvocableSkills(skills);
  if (menu.length === 0) return null;
  const byName = new Map(menu.map((s) => [s.name, s]));
  const list = menu.map((s) => `  · ${s.name} — ${s.description}`).join("\n");
  const names = menu.map((s) => s.name).join(" / ");
  return {
    name: SKILL_TOOL_NAME,
    category: "read", // 非危险:只读 md + 注入文本(对齐 dispatch_agent)
    description:
      "调用一个【技能(skill)】:把一段预置的专家流程/指令展开到当前对话,然后你按它去做。\n" +
      "适合有现成流程可循的任务(如按规范审查、按步骤发布)。可用技能:\n" +
      list +
      "\n把 name 传成上面之一;args 里放这次的具体对象(如文件路径、目标)。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: `技能名,取值之一:${names}` },
        args: { type: "string", description: "可选:这次调用的参数/上下文(如文件路径、目标)" },
      },
      required: ["name"],
    },
    run(input) {
      const name = String(input.name ?? "");
      const meta = byName.get(name);
      if (!meta) {
        // 未知 / disabled(不在菜单)→ 抛错,由 agent 转成 is_error 结果,让模型改口。
        throw new Error(`未知 skill: ${name}，可用: ${names}`);
      }
      return loadSkillBody(meta, input.args != null ? String(input.args) : undefined);
    },
  };
}
