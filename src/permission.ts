import type { ToolCategory } from "./types";

// 第 24 步：权限模式 —— 会话级审批策略（单一真相表）。
//
// 审批从「逐个危险工具 y/a/n ↔ 全放行」两极，升级为几档【权限模式】。
// 核心是一张表：模式 × 工具类别 → 策略（allow / ask / deny）。
//   - 工具类别在 Tool.category 上标注（read/edit/exec，缺省 read）；
//   - Agent.checkPermission 据【当前模式 + 工具类别】查这张表：
//       allow → 不问直接跑；deny → 不问直接拒（回 is_error）；ask → 走既有 onApprove。
// 加新模式 = 加一行；加新工具 = 归个类。见 docs/24 与 docs/adr/0008。

// 三态策略：直接放行 / 走人工确认 / 直接拒绝。
export type Policy = "allow" | "ask" | "deny";

// 四档权限模式（键用英文，对齐 Claude Code / Codex）。
export type PermissionMode = "default" | "acceptEdits" | "plan" | "yolo";

export const DEFAULT_MODE: PermissionMode = "default";

// 展示顺序（/mode 列表、文档）。
export const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "yolo",
];

// 单一真相：模式 → 类别 → 策略。
export const MODES: Record<PermissionMode, Record<ToolCategory, Policy>> = {
  // 默认：只读放行、改与执行都问（read_file/grep 归 read，故从旧的「每次问」改为放行）。
  default: { read: "allow", edit: "ask", exec: "ask" },
  // 自动改：文件编辑自动放行，shell/网络仍需确认（写代码最常用的中间态）。
  acceptEdits: { read: "allow", edit: "allow", exec: "ask" },
  // 规划：只读探查，任何改文件/执行一律拒（不问）。
  plan: { read: "allow", edit: "deny", exec: "deny" },
  // 全放行：一切自动执行、不再确认（= 旧的 AGENT_ALLOW_ALL）。
  yolo: { read: "allow", edit: "allow", exec: "allow" },
};

// 查策略：类别缺省按 read（无副作用兜底）；模式非法按 ask（fail safe）。
export function resolvePolicy(
  mode: PermissionMode,
  category: ToolCategory = "read",
): Policy {
  return MODES[mode]?.[category] ?? "ask";
}

// 每档一句中文说明（/mode 帮助 + 启动提示）。
export const MODE_LABELS: Record<PermissionMode, string> = {
  default: "只读放行，改文件/执行命令前逐个确认",
  acceptEdits: "文件编辑自动放行，shell/网络仍需确认",
  plan: "只读探查，任何改文件/执行一律拒绝",
  yolo: "一切自动执行、不再确认（⚠ 慎用）",
};

export function isPermissionMode(s: string): s is PermissionMode {
  return (MODE_ORDER as string[]).includes(s);
}

// 启动初始模式：AGENT_MODE 优先，非法回退 default（在【读取时】现取，便于测试覆盖）。
export function initialMode(): PermissionMode {
  const m = process.env.AGENT_MODE;
  return m && isPermissionMode(m) ? m : DEFAULT_MODE;
}

// 注入 system 的模式说明行（让模型主动适配当前模式）。
// default 不注入（它是基线，模型本按默认行为跑；也保持提示词缓存热路径稳定）——返回空串。
export function modeSystemLine(mode: PermissionMode): string {
  if (mode === "default") return "";
  if (mode === "plan") {
    return (
      "【当前权限模式：plan（只读规划）】只做只读探查（读文件 / grep / glob），" +
      "产出【方案 / 计划】而非直接改动；任何写文件、执行命令都会被系统拒绝。" +
      "需要动手实施时，请提示用户用 /mode acceptEdits 切换后再执行。"
    );
  }
  return `【当前权限模式：${mode}】${MODE_LABELS[mode]}`;
}
