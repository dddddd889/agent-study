import type { Message } from "./types";

// 上下文管理：估算历史的 token 数，并在过长时按「整轮」截断。
// 全部是纯函数，无副作用，方便离线单测。

// 判断一条消息是否为「真实的用户输入」（一轮对话的起点）。
// 约定（见 agent.ts）：用户输入以字符串 content 压入；工具结果以
// ContentBlock[] 压入。所以 role==="user" 且 content 是字符串 = 一轮的起点。
export function isUserInput(m: Message): boolean {
  return m.role === "user" && typeof m.content === "string";
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
  for (const m of messages) tokens += estimateText(messageText(m));
  return Math.ceil(tokens);
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
