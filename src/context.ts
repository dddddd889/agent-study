import { attachmentLabel, isAttachmentRef } from "./attachments";
import type { ContentBlock, Message } from "./types";

// 上下文管理：估算历史的 token 数，并在过长时按「整轮」截断。
// 全部是纯函数，无副作用，方便离线单测。

// 判断一条消息是否为「真实的用户输入」（一轮对话的起点）。
// user 角色的消息只有两类:真实用户输入,或工具结果回传。区分靠「有没有 tool_result 块」——
//   · 纯文本输入 → 字符串 content(真实输入)
//   · 带附件输入 → ContentBlock[](text + ref 块,无 tool_result)——【也是真实输入】(第29步)
//   · 工具结果   → ContentBlock[](tool_result 块)——不是轮起点
// 故:user 且【不是 tool_result 消息】= 一轮起点。旧版靠「content 是字符串」判定,会把附件轮
// 误判成非起点,导致压缩找不到切点/轮数漏计,故改用「排除 tool_result」这个更稳的判据。
export function isUserInput(m: Message): boolean {
  if (m.role !== "user") return false;
  // skill 正文(用户通道注入、带 skillMark)不是真实用户输入 —— 它和前面那条【原话】(不打标)
  // 同属一轮。若把它也算轮起点,连续两条 user 消息会让轮数虚涨、还可能把原话和正文切到两轮
  // (第30步)。故排除;原话(无 skillMark)照常是轮起点。
  if (m.skillMark) return false;
  if (typeof m.content === "string") return true;
  return !m.content.some((b) => b.type === "tool_result");
}

// 统计「轮数」（真实用户输入的条数）。
export function countTurns(messages: Message[]): number {
  return messages.filter(isUserInput).length;
}

// 粗略估算一段消息的 token 数。
// 经验法则：ASCII 约 4 字符/token，非 ASCII（中文等）约 1 token/字。
// 只求量级正确，不追求精确。
// TODO: 精确计数改用 Anthropic 的 count_tokens API（有网络/额度成本）。
export function estimateTokens(messages: Message[]): number {
  let tokens = 0;
  for (const m of messages) {
    tokens += estimateText(messageText(m));
    tokens += attachmentTokens(m); // 附件按 ref 块存好的估值直接计入(不走文本估算)
  }
  return Math.ceil(tokens);
}

// 附件 token：ref 块在 ingest 时已按 w×h/750(图)/ 页数×常量(PDF)算好、存进块里(见 attachments.ts),
// 这里直接累加,不必回碰 blob。messageText 对 ref 块返回 ""(贡献 0),故不会重复计。
function attachmentTokens(m: Message): number {
  if (typeof m.content === "string") return 0;
  return m.content.reduce((sum, b) => sum + (isAttachmentRef(b) ? b.tokens : 0), 0);
}

// 把历史蒸馏成纯文本,喂给「摘要压缩 / 长期记忆抽取」这类 LLM 子调用。统一两条剔除规则,
// 收成一处、让两个蒸馏点不漂移(见 ADR-0011 历史保真、docs/adr/0013 附件):
//   · 剔除思考块——模型草稿(含被丢弃的假设 + 一大坨签名),蒸馏成事实/摘要时纯属污染 + 烧 token。
//   · 附件 ref 块 → 文字标记 [图片 x.png]——蒸馏器是纯文本调用、看不见图,且绝不该把附件塞进去;
//     图的语义通常已在近期对话文本里,标记只需标出「曾有图」。
// 只改蒸馏【输入】的序列化:history 里的思考块 / ref 块一字不动(主循环回放仍原样保真)。
//
// dropSkill(第30步,skill 三层蒸馏):是否剔掉 skill 正文(带 skillMark 的消息/tool_result 块)。
//   · 长期记忆抽取传 true —— skill 是【流程指令】,沉淀进 .memory.md 是污染、且反过来废掉渐进披露。
//   · 摘要压缩传 false —— skill 正文当普通内容照摘(短期记忆里保留,老化随窗口正常压掉)。
// 这拆开了 memory 与 compactor 原本共用的别名(docs/adr/0013),是一处刻意的分叉:两者对 skill
// 正文的诉求本就不同(记忆别沉淀流程 / 压缩照常压)。见 CONTEXT.md「三层蒸馏处置」、docs/adr/0014。
// 标记【只盖 skill 正文,不盖意图】:同轮的用户原话 / 模型 tool_use(无 skillMark)照常保留。
export function serializeForDistill(
  messages: Message[],
  opts: { dropSkill?: boolean } = {},
): string {
  const lines: string[] = [];
  for (const m of messages) {
    // 用户通道注入的 skill 正文(整条消息带 skillMark):dropSkill 时整条剔除。
    if (opts.dropSkill && m.skillMark) continue;
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    const kept: ContentBlock[] = [];
    const markers: string[] = [];
    for (const b of m.content) {
      if (b.type === "thinking" || b.type === "redacted_thinking") continue;
      // 模型通道的 skill 正文(块级 skillMark 的 tool_result):dropSkill 时只剔这一块,
      // 不误伤同轮批量收集进同一条消息的别的工具结果。
      if (opts.dropSkill && b.type === "tool_result" && b.skillMark) continue;
      if (isAttachmentRef(b)) {
        markers.push(`[${attachmentLabel(b)} ${b.name}]`);
        continue;
      }
      kept.push(b);
    }
    // 整条都被剔空(如只含一块 skill 正文的 tool_result 消息)→ 不产出空行。
    if (kept.length === 0 && markers.length === 0) continue;
    const parts: string[] = [];
    if (kept.length > 0) parts.push(JSON.stringify(kept));
    parts.push(...markers);
    lines.push(`${m.role}: ${parts.join(" ")}`);
  }
  return lines.join("\n");
}

function estimateText(s: string): number {
  let t = 0;
  for (const ch of s) {
    t += (ch.codePointAt(0) ?? 0) > 0x7f ? 1 : 0.25;
  }
  return t;
}

// 把一条消息里的所有文本抽出来（含工具调用参数和工具结果），用于估算。
function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return b.name + JSON.stringify(b.input);
      if (b.type === "tool_result") return b.content;
      return "";
    })
    .join("");
}

// 为「摘要压缩」切分历史：保留最近 keepTurns 轮逐字，其余作为「旧轮」待摘要。
// 在「真实用户输入」处对齐切分，保证 old 是整轮、recent 以真实 user 输入开头(都合法)。
// 轮数 ≤ keepTurns 时 old 为空(没有可摘要的旧轮)。
//
// frozenCount：内存历史开头有几条是「冻结摘要块」(见 docs/28、记忆游标)。
// 冻结区是不可动的前缀 —— 切分只在 messages.slice(frozenCount) 上找轮边界，
// 返回的 old/recent 都**不含**冻结区(由调用方拼回),这样已冻结的块永不再被划进 old 重摘。
// 缺省 0 时行为与旧版完全一致。
export function splitForCompaction(
  messages: Message[],
  keepTurns: number,
  frozenCount = 0,
): { old: Message[]; recent: Message[] } {
  // frozenCount === 0 时不切片,保持返回原数组引用(旧调用方/测试依赖)。
  const rest = frozenCount > 0 ? messages.slice(frozenCount) : messages;
  const starts: number[] = [];
  rest.forEach((m, i) => {
    if (isUserInput(m)) starts.push(i);
  });
  if (starts.length <= keepTurns) return { old: [], recent: rest };
  const cut = starts[starts.length - keepTurns]!;
  return { old: rest.slice(0, cut), recent: rest.slice(cut) };
}

// 按「整轮」截断历史，使估算 token ≤ maxTokens。
// 安全约束（见 docs/04）：
//   1. 只在「真实用户输入」处对齐，结果第一条一定是真实用户输入，
//      不会出现孤儿 tool_result；
//   2. 工具轮整轮保留或整轮丢弃，不拆散 tool_use / tool_result；
//   3. 至少保留最近 1 轮（即使它自身就超预算 —— 那只能靠摘要进一步压缩）。
//
// frozenCount：开头的冻结摘要块**永不丢弃**。截断只在 frozenCount 之后的逐字轮里
// 找边界丢最旧的,冻结区始终原样保留并拼在结果最前。用作「增量冻结的摘要失败」兜底
// (见 docs/28)：一次网络抖动不该把辛苦攒下的长期摘要截掉。缺省 0 时行为同旧版。
// 纯函数：返回新数组（或原数组），不修改入参。
export function truncateHistory(
  messages: Message[],
  maxTokens: number,
  frozenCount = 0,
): Message[] {
  if (estimateTokens(messages) <= maxTokens) return messages;

  const frozen = frozenCount > 0 ? messages.slice(0, frozenCount) : [];
  const frozenTokens = estimateTokens(frozen);
  const withFrozen = (start: number): Message[] =>
    frozenCount > 0 ? [...frozen, ...messages.slice(start)] : messages.slice(start);

  // frozenCount 之后所有「轮起点」的绝对下标(冻结区不参与截断)。
  const starts: number[] = [];
  messages.forEach((m, i) => {
    if (i >= frozenCount && isUserInput(m)) starts.push(i);
  });
  if (starts.length === 0) return messages; // 没有可对齐的边界，保守不动

  // 从最旧到最新，找第一个「冻结区 + 从这里保留到结尾」能落进预算的轮起点。
  for (const start of starts) {
    if (frozenTokens + estimateTokens(messages.slice(start)) <= maxTokens) {
      return withFrozen(start);
    }
  }
  // 连(冻结区 + 最近一轮)都超预算：仍保留冻结区 + 最近 1 轮。
  return withFrozen(starts[starts.length - 1]!);
}
