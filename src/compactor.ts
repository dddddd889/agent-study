import {
  countTurns,
  estimateTokens,
  serializeForDistill,
  splitForCompaction,
  truncateHistory,
} from "./context";
import { collectStream } from "./llm";
import type { LLM, Message, Usage } from "./types";

// 摘要消息的标记前缀(置顶 user 消息)。每个冻结块都带它,故 hasSummary 恒等于 frozenCount>0。
export const SUMMARY_PREFIX = "[对话摘要]";
// 摘要那次 LLM 调用的 system 提示(测试也据 "摘要" 关键字识别这次调用)。
const SUMMARY_SYSTEM = "你是对话摘要器，只输出摘要正文，不要寒暄或任何前后缀。";

// 冻结状态：内存历史开头有几条是「冻结摘要块」(不可动前缀),以及与之一一对应的游标。
// Agent 持有它(见 ADR-0012「写入侧收成 ContextCompactor」),压缩时传进传出;
// Compactor 自身无状态,只持配置 + 注入的 llm。
export interface FrozenState {
  // history 开头的冻结块数(不可动前缀)。
  frozenCount: number;
  // frozenCursors[i] = 折进前 i+1 块的「原始消息累计数」;末元素即当前游标。
  frozenCursors: number[];
}

// 一次压缩的汇报载荷(= Agent.onCompact 的入参)。单次终态,故作返回值而非回调。
export interface CompactEvent {
  strategy: "freeze" | "merge" | "truncate";
  droppedTurns: number; // freeze/truncate: 折叠或丢弃的轮数
  mergedBlocks?: number; // merge: 参与合并的冻结块数
  frozenBlocks: number; // 压缩后的冻结块数
  cursor: number; // 记忆游标:已折进冻结块的原始消息数
  beforeTokens: number;
  afterTokens: number;
}

export interface CompactResult {
  history: Message[];
  frozen: FrozenState;
  event?: CompactEvent; // 未发生压缩(未过阈值 / 无可摘旧轮)时为 undefined
}

export interface CompactorOptions {
  // 摘要/合并那次调用用的 LLM(与主循环同实例)。构造注入:llm 是稳定协作者,不是每轮变化的数据。
  llm: LLM;
  // 连续副作用回报:每次摘要 LLM 调用(含中断兜底)把用量回流给 Agent,计入主桶。
  onUsage: (u?: Usage) => void;
  // 历史估算 token 超过此「软目标」时压缩。默认 100000。
  maxContextTokens?: number;
  // 压缩时保留最近几轮逐字(更早的轮摘要掉)。默认 2。
  keepRecentTurns?: number;
  // 合并触发:冻结块数 ≥ 此值就把全部冻结块塌成一块。默认 5。
  mergeBlockThreshold?: number;
  // 合并触发:摘要区估算 token ≥ maxContextTokens × 此比例 就合并。默认 0.25。
  mergeZoneRatio?: number;
}

// 摘要/合并那次 LLM 调用的输入序列化 = 通用蒸馏(剔思考 + 附件转文字标记),与长期记忆抽取共用
// context.serializeForDistill(收口一处避免漂移)。摘要要的是状态/结论,不是推演过程;不影响思考保真。
const serializeForSummary = serializeForDistill;

// 上下文压缩器(见 docs/28、ADR-0012)：把「历史太长了帮我压一下」这件事收成深模块。
// 窄接口 compact() 藏三策略(增量冻结 / 合并 / 截断兜底)+ 游标数学。无状态:Agent 持 history
// 与冻结状态、传进传出;压缩器只持配置 + llm。摘要那次调用的用量经 onUsage 回流主桶。
export class ContextCompactor {
  private llm: LLM;
  private onUsage: (u?: Usage) => void;
  private readonly maxCtxTokens: number;
  private keepRecentTurns: number;
  private mergeBlockThreshold: number;
  private mergeZoneRatio: number;

  constructor(opts: CompactorOptions) {
    this.llm = opts.llm;
    this.onUsage = opts.onUsage;
    this.maxCtxTokens = opts.maxContextTokens ?? 100000;
    this.keepRecentTurns = opts.keepRecentTurns ?? 2;
    this.mergeBlockThreshold =
      opts.mergeBlockThreshold ?? (Number(process.env.AGENT_MERGE_BLOCKS) || 5);
    this.mergeZoneRatio =
      opts.mergeZoneRatio ?? (Number(process.env.AGENT_MERGE_ZONE_RATIO) || 0.25);
  }

  // 软目标,供 contextStats 观测(Agent 不再自存此值)。
  get maxContextTokens(): number {
    return this.maxCtxTokens;
  }

  // 上下文管理：历史估算 token 超过软目标时,按「记忆游标」压缩(见 docs/28)。
  // 三段结构：[冻结块 s1..sn] | [已老化未摘的轮] | [最近 keepRecentTurns 轮逐字]。
  //   · 增量冻结(常态)：只把中间段摘成【一个新块】追加到摘要区,游标右移,已冻结块一字不动;
  //     生成时把摘要区作【只读上下文】喂入保连贯(看≠改写,不接上「摘要的摘要」的退化链)。
  //   · 合并(低频)：冻结块数或摘要区占比到阈值 → 把全部冻结块重摘塌成一块、计数归零。
  //   · 兜底：增量摘要失败 → 只截 frozenCount 之后的逐字轮,冻结块不动。
  // 一次性、尽力而为:压不到软目标也不反复摘、不报错,原样返回(event 为 undefined)。
  // 无状态:不改 Agent 的任何字段,新历史 + 新冻结状态经返回值交回。
  async compact(
    history: Message[],
    frozen: FrozenState,
    signal?: AbortSignal,
  ): Promise<CompactResult> {
    const { frozenCount, frozenCursors } = frozen;
    const beforeTokens = estimateTokens(history);
    // 原样返回(未压缩)：保持入参引用,Agent 写回是幂等空操作。
    const unchanged: CompactResult = { history, frozen, event: undefined };
    if (beforeTokens <= this.maxCtxTokens) return unchanged;

    const frozenMsgs = history.slice(0, frozenCount);
    const { old, recent } = splitForCompaction(
      history,
      this.keepRecentTurns,
      frozenCount,
    );
    if (old.length === 0) return unchanged; // 冻结区之后没有可摘的旧轮,按现状继续

    const cursorPos = frozenCursors[frozenCursors.length - 1] ?? 0;

    let next: Message[];
    let strategy: "freeze" | "merge" | "truncate";
    let droppedTurns = 0;
    let mergedBlocks: number | undefined;
    // 只在整段成功构建后才提交游标/frozenCount,避免合并失败留下半更新的状态。
    let nextFrozenCount = frozenCount;
    let nextCursors = frozenCursors;
    try {
      // 增量冻结：中间段摘成一个新块,摘要区作只读上下文喂入。
      const block = await this.summarize(old, signal, frozenMsgs);
      let blocks: Message[] = [
        ...frozenMsgs,
        { role: "user", content: `${SUMMARY_PREFIX}\n${block}` },
      ];
      // 新块的 cursorAfter = 上一块的 + 本次折进的原始消息数。
      let cursors = [...frozenCursors, cursorPos + old.length];
      droppedTurns = countTurns(old);

      // 合并判定：块数或摘要区占比到阈值 → 全部冻结块塌成一块(游标不变)。
      if (this.shouldMerge(blocks)) {
        mergedBlocks = blocks.length;
        const merged = await this.mergeFrozen(blocks, signal);
        blocks = [{ role: "user", content: `${SUMMARY_PREFIX}\n${merged}` }];
        cursors = [cursors[cursors.length - 1]!]; // 单块覆盖全部已折原始消息
        strategy = "merge";
      } else {
        strategy = "freeze";
      }
      next = [...blocks, ...recent];
      nextFrozenCount = blocks.length;
      nextCursors = cursors;
    } catch (err) {
      if (signal?.aborted) throw err; // 用户中断 => 交给 send 封口，不当作摘要失败
      // 摘要/合并失败(网络等)=> 只截 frozenCount 之后的逐字轮,冻结块一字不动。
      next = truncateHistory(history, this.maxCtxTokens, frozenCount);
      strategy = "truncate";
      droppedTurns = countTurns(history) - countTurns(next);
      // nextFrozenCount / nextCursors 不变(截断保留整个冻结区)
    }

    return {
      history: next,
      frozen: { frozenCount: nextFrozenCount, frozenCursors: nextCursors },
      event: {
        strategy,
        droppedTurns,
        mergedBlocks,
        frozenBlocks: nextFrozenCount,
        cursor: nextCursors[nextCursors.length - 1] ?? 0,
        beforeTokens,
        afterTokens: estimateTokens(next),
      },
    };
  }

  // 合并触发判定：冻结块数到阈值 或 摘要区估算 token 到 maxContextTokens 的占比。
  private shouldMerge(frozenBlocks: Message[]): boolean {
    if (frozenBlocks.length >= this.mergeBlockThreshold) return true;
    return estimateTokens(frozenBlocks) >= this.maxCtxTokens * this.mergeZoneRatio;
  }

  // 把一段旧消息调一次 LLM 浓缩成摘要文本(无工具、聚焦提示、drain 取文本)。
  // context：已有冻结块,作【只读上下文】喂入帮助解引用 —— 只参考、不复述、不改写。
  private async summarize(
    messages: Message[],
    signal?: AbortSignal,
    context: Message[] = [],
  ): Promise<string> {
    let prompt =
      "请把下面这段对话浓缩成简洁摘要，保留关键事实、用户偏好、已做的决定和未完成事项，省略寒暄。只输出摘要正文：\n\n" +
      serializeForSummary(messages);
    if (context.length > 0) {
      prompt =
        "【已有摘要（只读上下文，帮助你理解下文的指代；不要复述、不要改写它）】：\n" +
        serializeForSummary(context) +
        "\n\n" +
        prompt;
    }
    return this.runSummaryCall(prompt, signal);
  }

  // 合并：把多个冻结块重摘成一段连贯、去重的摘要(低频事件)。
  private async mergeFrozen(
    blocks: Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt =
      "请把下面这几段对话摘要合并成一段连贯、去重的摘要，保留全部关键事实、用户偏好、已做的决定和未完成事项。只输出合并后的摘要正文：\n\n" +
      serializeForSummary(blocks);
    return this.runSummaryCall(prompt, signal);
  }

  // 摘要/合并共用的那次 LLM 调用（无工具、聚焦 system、drain 取文本、用量回流主桶）。
  private async runSummaryCall(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const it = this.llm.stream([{ role: "user", content: prompt }], {
      system: SUMMARY_SYSTEM,
      signal,
      thinking: false, // 摘要是工具调用,不思考(省 token)
      onUsage: (u) => this.onUsage(u), // 中断兜底:被中断时正常 return 走不到,靠这里补记
    });
    const { text, response } = await collectStream(it); // 静默收(含空流兜底)
    this.onUsage(response.usage); // 正常完成:计入本会话
    return text;
  }
}
