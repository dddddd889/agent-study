// 第 18 步:子 agent 角色注册表 —— 集中登记所有角色的配置(单一真相)。
//
// 角色 = 一段 system 提示 + 一套工具裁法 + 预算,决定子 agent「怎么想、能用什么」。
// 加一个新角色 = 在这张表加一行,不用手写新工具。见 docs/18 与 docs/adr/0004。
//
// 暴露方式按输入形状分两种(kind):
//   - "prompt"     : 输入就是一段 prompt,经 dispatch_agent(agent_type, prompt) 选择;
//   - "structured" : 输入是结构化的(如 critic 的 task/output),保留为独立工具,但配置仍在此表。
//
// 工具裁法基线(见 subagent.ts):任何角色的工具集 = 全套 −{dispatch_agent, critic} − 角色的 exclude。
// 基线剔除两个「会起子 agent」的工具,从根上禁嵌套(ADR-0001/0004);exclude 再按角色收紧。

export type RoleKind = "prompt" | "structured";

export interface Role {
  // 给模型看的一句话说明(dispatch_agent 的 agent_type 描述会枚举它)。
  description: string;
  // 该角色子 agent 的 system 提示。
  system: string;
  // 在基线之上额外剔除的工具名(如只读角色剔除 write_file)。默认不额外剔除。
  exclude?: string[];
  // 可选:覆盖该角色的步数上限(不填用 SUBAGENT_MAX_STEPS 默认)。
  maxSteps?: number;
  // 暴露方式:prompt 式走 agent_type,structured 式独立成工具。
  kind: RoleKind;
}

export const DEFAULT_ROLE = "general";

export const ROLES: Record<string, Role> = {
  // 通用干活子 agent(默认)。老用法 dispatch_agent({prompt}) 就是它。
  general: {
    kind: "prompt",
    description: "通用:自主完成一个独立子任务(可读写文件、跑命令、联网),给出结论",
    exclude: [],
    system:
      "你是一个自主子 agent,被主 agent 交办一个独立、边界清晰的子任务。\n" +
      "你【看不到】主对话历史,完成任务所需的全部背景都已写在下面的任务描述里。\n" +
      "请自行使用工具把任务做完,最后用简洁的文字给出【结论】——" +
      "主 agent 只会收到你最后这段文字、看不到你的中间过程,所以结论必须能独立看懂。",
  },

  // 只读探索/检索:找文件、读代码、搜集信息,不改动。对标 Claude Code 的 Explore。
  explore: {
    kind: "prompt",
    description: "只读探索:找文件/读代码/检索信息,不改动任何东西,产出发现与结论",
    exclude: ["write_file"],
    system:
      "你是一个【只读探索】子 agent,被主 agent 派来搜集信息、摸清情况。\n" +
      "你【看不到】主对话历史,任务背景都在下面。\n" +
      "只做只读的查找与阅读(读文件、grep、必要时联网),【绝不修改】任何文件或状态。\n" +
      "最后给出简洁的【发现】:关键事实、相关位置(文件/行)、以及对任务的结论。",
  },

  // 只读规划:研究后产出实现方案/步骤,不动手改。对标 Claude Code 的 Plan。
  plan: {
    kind: "prompt",
    description: "只读规划:研究后产出实现方案/步骤清单,不动手改代码",
    exclude: ["write_file"],
    system:
      "你是一个【只读规划】子 agent,被主 agent 派来研究并制定实现方案。\n" +
      "你【看不到】主对话历史,任务背景都在下面。\n" +
      "只做只读研究(读文件、grep),【绝不修改】任何文件。\n" +
      "最后产出一份【实现方案】:分步骤、点明涉及的文件与取舍,让主 agent 照着就能动手。",
  },

  // 对抗性审查者(第17步)。structured:输入是 task/output/…,由 critic 独立工具承接。
  critic: {
    kind: "structured",
    description: "对抗性审查者:审查一份产出,给出结构化裁定(通过/不通过 + 分级问题 + 建议)",
    exclude: ["write_file"],
    system:
      "你是一个对抗性审查者(critic),被主 agent 请来审查一份产出。\n" +
      "你【看不到】主对话历史 —— 要审的【原始任务】和【产出结果】都已写在下面的输入里" +
      "(只给结果不给任务无法判对错:给「2」却不知问的是不是「1+1」)。\n" +
      "职责是【挑出问题】而非附和。有可查的实物(代码/文件)就【亲自核对】:读文件、grep、跑测试," +
      "别只信一面之词;没有实物时,就对照任务与标准审查文本本身。\n" +
      "你【只审查、绝不修改】任何文件或状态;shell 仅用于只读查验与跑测试。\n" +
      "最后【只输出】这段裁定,严格按格式:\n" +
      "裁定：通过 / 不通过\n" +
      "问题：\n" +
      "  [严重] …(阻断性:结果错 / 不满足硬性要求 / 测试失败)\n" +
      "  [次要] …(不影响正确性的改进项)\n" +
      "建议：一句话下一步(如「先修严重项再复审」;无问题则「可交付」)",
  },
};

// prompt 式角色名(供 dispatch_agent 动态生成 agent_type 枚举 + 描述)。
export function promptRoleNames(): string[] {
  return Object.keys(ROLES).filter((k) => ROLES[k]!.kind === "prompt");
}

// 取角色配置;未知类型宽松回退到默认 general(不报错)。
export function resolveRole(type: string | undefined): Role {
  return ROLES[type ?? DEFAULT_ROLE] ?? ROLES[DEFAULT_ROLE]!;
}
