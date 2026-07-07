// 一条对话消息的角色。最简循环里只有 user / assistant 两种角色。
export type Role = "user" | "assistant";

// ============ 内容块（content blocks）============
// Anthropic Messages API 的 content 既可以是一段纯文本字符串，
// 也可以是一个「内容块」数组。引入工具调用后，一条消息里可能同时包含
// 文本和工具调用，所以必须用数组形式来表达。

// 模型或用户输出的普通文本。
export interface TextBlock {
  type: "text";
  text: string;
}

// 扩展思考块(第27步):模型答复前的推理。thinking=正文,signature=校验签名。
// 带工具调用的轮里必须【原样含签名】回传,否则 API 拒 → 见 docs/27。
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

// 加密的思考块(安全过滤时返回):内容看不懂,但同样必须原样回传。
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

// 模型请求调用某个工具（出现在 assistant 消息里）。
export interface ToolUseBlock {
  type: "tool_use";
  id: string; // 本次调用的唯一 id，结果要用它对应回来
  name: string; // 要调用的工具名
  input: Record<string, unknown>; // 模型给出的参数
}

// 工具执行结果（作为 user 消息回传给模型）。
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string; // 对应某个 ToolUseBlock.id
  content: string; // 工具返回的文本结果
  is_error?: boolean; // 执行出错时置 true，模型会据此调整
  // skill 标记(块级):这条 tool_result 是 skill 正文(模型通道)时置为 skill 名。
  // 用途:长期记忆抽取据此把 skill 正文剔掉(见 context.serializeForDistill 的 dropSkill、
  // CONTEXT.md「skill 标记」/「三层蒸馏处置」、docs/adr/0014)。块级(而非消息级)是为了在
  // skill 与其它工具【同轮批量】收进一条 user 消息时,只剔 skill 那一块、不误伤同批别的结果。
  // 【绝不影响落盘】:JSONL 里 content 原样存,skill 正文进流水(唯一真相)。
  skillMark?: string;
}

// ============ 附件（图片 / PDF）============
// 用户挂进消息、供模型「看」的本地图片 / PDF（第29步）。见 CONTEXT.md「附件」、docs/adr/0013。
// 三种块的关系：
//   · ImageBlock / DocumentBlock —— 照抄 Anthropic API 的 base64 形态，只在【喂 API 前重放】时临时出现。
//   · AttachmentRefBlock         —— 历史 / JSONL 里的存在形态，只存内容寻址引用,永不内联 base64。
// 二者顶层 type 都是 "image"|"document"，靠「有没有 ref 字段」区分(见 attachments.ts 的 isAttachmentRef)。

// API 的 base64 来源。字段是【蛇形】(media_type)——因为 llm.ts 原样透传给 Anthropic API,
// 必须用 API 的线上字段名。本步只用 base64;url / file 来源留 TODO。
export interface Base64Source {
  type: "base64";
  media_type: string; // image/png | image/jpeg | image/gif | image/webp | application/pdf
  data: string; // base64,无换行
}

// 图片块（重放后的线上形态）。
export interface ImageBlock {
  type: "image";
  source: Base64Source;
}

// PDF 块（重放后的线上形态）。与 image 并列——API 对二者处理不同(PDF 服务端拆逐页文本+页图)。
export interface DocumentBlock {
  type: "document";
  source: Base64Source;
}

// 附件 ref 块：历史与落盘里的存在形态。不含 base64,只存内容寻址引用 + 元信息 + token 估值。
// mediaType 用【驼峰】(与线上 Base64Source.media_type 区分)——ref 块永不直接发给 API。
export interface AttachmentRefBlock {
  type: "image" | "document";
  ref: string; // 内容哈希(sha256),对应 blob 仓里的文件名
  name: string; // 原文件名,供文字标记 / 展示
  mediaType: string; // 以魔数为准
  tokens: number; // ingest 时算好,供 estimateTokens 直接读,不必回碰 blob
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | AttachmentRefBlock;

// 一条对话消息：content 可以是简单字符串（纯文本场景），
// 也可以是内容块数组（涉及工具时）。两种形式 Anthropic API 都接受。
export interface Message {
  role: Role;
  content: string | ContentBlock[];
  // skill 标记(消息级):这【整条】消息是 skill 正文(用户通道 /<name> 注入的那条)时置为 skill 名。
  // 用户通道无 tool_use、正文只能作 user 消息注入,故标在消息级;模型通道则标在 ToolResultBlock 上。
  // 用途同 ToolResultBlock.skillMark:长期记忆抽取据此剔除。仅是元信息,不改 content、不发给 API、
  // 落盘 JSON 往返即可(见 CONTEXT.md「skill 标记」、docs/adr/0014)。
  skillMark?: string;
}

// ============ 冻结区重建（restoreFrozen）============
// 续聊时对「摘要缓存 sidecar」的读取侧结果。见 session.ts 的 restoreFrozen、
// CONTEXT.md「冻结区重建」、docs/adr/0012。
//   frozen  : 命中——sidecar 有效且游标对得上主流水,按冻结块 + 游标之后逐字重建
//   missing : 无 sidecar(没压缩过的新会话)——常态,静默
//   corrupt : 文件损坏 / 结构不自洽——坏缓存,告警
//   invalid : 游标对不上主流水(越界或没落在轮边界)——多半是逻辑 bug,告警
export type RestoreReason = "frozen" | "missing" | "corrupt" | "invalid";

// 「重建方案」：统一退化形状。命中时 blocks/cursors 非空、rest = 主流水游标之后;
// 任何不命中一律退化成「空冻结块 + rest = 整条主流水」,于是调用方【无需分支】——
// loadHistoryWithFrozen(plan) 对命中/回退都成立(空 blocks 自然等价于全量恢复)。
export interface RestorePlan {
  blocks: string[]; // 冻结块正文(含 [对话摘要] 前缀);回退时为空
  cursors: number[]; // 各块 cursorAfter;回退时为空
  rest: Message[]; // 要逐字灌入的主流水尾巴(命中=slice(cursor),回退=整条)
  reason: RestoreReason;
}

// ============ 工具定义 ============
// 工具类别（第24步：权限模式据此决策）：
//   read : 只读、无副作用（read_file/grep/glob…）
//   edit : 改文件（write_file/edit_file/apply_patch）
//   exec : 执行 & 网络（shell/http_request、MCP 外部工具）
// 取代旧的 dangerous 布尔：edit/exec 即「危险」、read 即「安全」；缺省按 read。见 src/permission.ts。
export type ToolCategory = "read" | "edit" | "exec";

// 工具执行的上下文。用对象包装是为了可扩展（以后可加 onProgress / cwd 等）。
export interface ToolContext {
  // 中断信号：abort 后，会阻塞的工具（http / shell / 读写文件）应尽快停止。
  signal?: AbortSignal;
  // 每个 Agent 自己的「已读文件集合」(运行时、非持久)。read_file/write_file 成功后把
  // 文件绝对路径记进来;Edit 据此强制「先读再改」(read-before-edit)。主/子 agent 各一份,
  // 天然隔离、不串味。见 docs/19、ADR-0005。
  readFiles?: Set<string>;
}

// 一个工具 = 给模型看的「说明书」(name/description/inputSchema)
//          + 本地真正执行的逻辑 (run)。
export interface Tool {
  name: string;
  description: string; // 写清楚“什么时候用它”，模型据此决定是否调用
  // 工具类别（read/edit/exec，缺省 read）。权限模式据此决定放行/询问/拒绝。见 src/permission.ts。
  category?: ToolCategory;
  // 辅助工具（如 todo 记账）：本身不推进任务,调用它【不计入 maxSteps 步数预算】。
  // 否则「每步都更新 todo」会蚕食步数,让真正干活 + 收尾挤不进上限。见 docs/14。
  auxiliary?: boolean;
  // 可并发工具（如 dispatch_agent 派子 agent）：无副作用竞态、可安全并行。
  // 仅当【某一轮的工具调用全是 concurrent】时,Agent 才并发执行它们;只要混进任何
  // 非 concurrent 工具(write_file/shell 等讲顺序/有副作用的),整轮退回串行。见 docs/16。
  concurrent?: boolean;
  // JSON Schema，描述参数结构，模型据此生成 input。
  inputSchema: Record<string, unknown>;
  // 实际执行：拿到模型给的参数（和可选上下文），返回文本结果（可异步）。
  run(
    input: Record<string, unknown>,
    ctx?: ToolContext,
  ): string | Promise<string>;
}

// ============ LLM 抽象 ============
// 单次模型调用的 token 用量(第22步:提示词缓存观测)。
//   input         : 未命中缓存、按全价计的输入 token
//   output        : 输出 token
//   cacheRead     : 从缓存读取的输入 token(~0.1× 价)
//   cacheCreation : 写入缓存的输入 token(5min TTL ~1.25× 价)
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// 引入工具后，单次回复不再只是一段文本：它可能包含 tool_use 块，
// 还需要 stopReason 来判断「是否要继续循环」。
export interface LLMResponse {
  // "end_turn" | "tool_use" | "max_tokens" | ...
  stopReason: string;
  // assistant 这一步产出的内容块（文本 + 可能的 tool_use）。
  content: ContentBlock[];
  // 本次调用的 token 用量(含缓存读写),供 /context 观测;不支持时可缺省。
  usage?: Usage;
}

export interface CompleteOptions {
  system?: string;
  tools?: Tool[];
  // 中断信号：abort 后正在进行的 fetch/SSE 流会立即断开。
  signal?: AbortSignal;
  // 第27步:每调用覆盖是否开扩展思考。省略=跟随 LLM 实例默认(env AGENT_THINKING);
  // 内部工具调用(摘要/记忆抽取)传 false 关掉,省 token。
  thinking?: boolean;
  // 思考正文增量回调(暗色显示);不 yield,避免混进答复文本。
  onThinkingDelta?: (text: string) => void;
  // 中断兜底:流【中途抛错】(如用户中断)时,把已产生的 usage 回调出来。
  // 正常读完不触发(那时 usage 随 return 的 LLMResponse 交出)。见 stream() 的 finally。
  onUsage?: (usage: Usage) => void;
}

// LLM 抽象接口：给定历史消息（和可选 system / tools），流式产出助手的下一步输出。
// 抽象成接口，是为了让 Agent 不依赖具体厂商，测试时可换成 FakeLLM。
//
// stream() 是异步生成器：
//   - yield 出「文本增量」(string)，供上层边到边显示；
//   - return 出组装好的完整 LLMResponse（文本 + 工具调用 + stopReason），
//     供 agent 循环判断是否继续。
// 不需要实时显示时，忽略 yield 的增量、只用 return 的结果即可。
export interface LLM {
  stream(
    messages: Message[],
    opts?: CompleteOptions,
  ): AsyncGenerator<string, LLMResponse>;
}
