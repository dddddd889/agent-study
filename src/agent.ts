import {
  countTurns,
  estimateTokens,
  splitForCompaction,
  truncateHistory,
} from "./context";
import { collectStream, extractText } from "./llm";
import {
  initialMode,
  modeSystemLine,
  type PermissionMode,
  resolvePolicy,
} from "./permission";
import type {
  LLM,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "./types";

// 摘要消息的标记前缀(置顶 user 消息),也用于 contextStats 判断「是否含摘要」。
export const SUMMARY_PREFIX = "[对话摘要]";
// 摘要那次 LLM 调用的 system 提示(测试也据 "摘要" 关键字识别这次调用)。
const SUMMARY_SYSTEM = "你是对话摘要器，只输出摘要正文，不要寒暄或任何前后缀。";

export interface AgentOptions {
  system?: string;
  tools?: Tool[];
  // 工具循环里【干活步数】的上限，防止模型反复调工具陷入死循环。默认 10。
  // 注：辅助工具(tool.auxiliary,如 todo 记账)不计入此预算,见 send() 与 docs/14。
  maxSteps?: number;
  // 并发上限：一轮里若同时执行多个 concurrent 工具(如并行子 agent),最多几个在飞。
  // 默认 5(或 AGENT_MAX_CONCURRENCY)。防一次派几十个打爆 API / 本机。见 docs/16。
  maxConcurrency?: number;
  // 上下文管理：历史估算 token 超过此「软目标」时压缩。默认 100000。
  // 想观察压缩效果，把它调小（如 500）即可。注意是软目标 —— 压不到也只尽力而为。
  maxContextTokens?: number;
  // 压缩时保留最近几轮逐字（更早的轮摘要掉）。默认 2。
  keepRecentTurns?: number;
  // 模型回复的文本增量回调，便于 CLI 边生成边显示（流式）。
  onTextDelta?: (text: string) => void;
  // 扩展思考(第27步):思考正文增量回调(CLI 暗色显示);不进答复文本。
  onThinkingDelta?: (text: string) => void;
  // 扩展思考的每-Agent 覆盖:省略=跟随 LLM 实例默认(env);false=强制关(子 agent 关思考用)。
  thinking?: boolean;
  // 可选事件回调，便于 CLI 展示「正在调用工具 / 工具结果」等过程。
  onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
  onToolResult?: (result: {
    name: string;
    content: string;
    isError: boolean;
  }) => void;
  // 上下文被压缩时触发，便于 CLI 显示「已摘要/截断旧对话」。
  // strategy: "summarize" 摘要 / "truncate" 摘要失败的回退截断。
  onCompact?: (info: {
    strategy: "summarize" | "truncate";
    droppedTurns: number;
    beforeTokens: number;
    afterTokens: number;
  }) => void;
  // 一轮的消息「提交到历史」时触发（正常结束 + 中断封口都算），
  // 带本轮新增的消息，供上层持久化（追加落盘）。
  onTurnComplete?: (added: Message[]) => void;
  // 权限模式（第24步）：会话级审批策略。不填读 AGENT_MODE、再默认 default。见 src/permission.ts。
  mode?: PermissionMode;
  // 工具执行前的人工确认，仅在【当前模式对该工具类别判定为 ask】时才调用。返回：
  //   "once" 允许这一次 / "always" 本会话内总是允许该工具 / "deny" 拒绝。
  // 不提供则「ask 档」的工具一律默认拒绝（fail closed）。allow/deny 档不经过它。
  onApprove?: (call: {
    name: string;
    input: Record<string, unknown>;
  }) => Promise<"once" | "always" | "deny">;
}

// 把一次调用的用量累加进目标桶(缺省则跳过)。第22步缓存观测用。
function addUsageInto(dst: Usage, src?: Usage): void {
  if (!src) return;
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheCreation += src.cacheCreation;
}

// 极简异步信号量:限制同时在飞的任务数(并行子 agent 的并发上限)。
// run() 里超额就 await 排队,有任务结束就唤醒一个等待者。JS 单线程,计数无需加锁。
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.(); // 让出一个名额,唤醒下一个排队者
    }
  }
}

// 带工具调用循环的 Agent。
// 相比最简对话循环，核心变化是：send() 不再「一问一答」，而是一个循环——
// 调模型 -> 若模型要用工具就执行 -> 把结果喂回历史 -> 再调模型 -> ...
// 直到模型不再要工具、给出最终答复。历史里会完整累积每一步的
// tool_use 和 tool_result，所以模型始终“知道之前每一步发生了什么”。
export class Agent {
  private llm: LLM;
  private system?: string;
  private tools: Tool[];
  private maxSteps: number;
  private maxConcurrency: number;
  private maxContextTokens: number;
  private keepRecentTurns: number;
  private onTextDelta?: AgentOptions["onTextDelta"];
  private onThinkingDelta?: AgentOptions["onThinkingDelta"];
  private thinking?: boolean;
  private onToolCall?: AgentOptions["onToolCall"];
  private onToolResult?: AgentOptions["onToolResult"];
  private onCompact?: AgentOptions["onCompact"];
  private onTurnComplete?: AgentOptions["onTurnComplete"];
  private onApprove?: AgentOptions["onApprove"];
  // 当前权限模式（第24步）：会话级审批策略，可运行时用 setMode 切换。
  private mode: PermissionMode;
  // 本会话内「总是允许」的工具名（在 ask 档选了 always 的）。仅在 ask 档生效;deny 无视它。
  private alwaysAllowed = new Set<string>();
  // 本 Agent 读过的文件（绝对路径）。供 Edit 强制「先读再改」;每个 Agent 各一份(见 docs/19)。
  private readFiles = new Set<string>();
  // 本会话累计 token 用量(含缓存读写),供 /context 观测(第22步)。reset/new 清零。
  // 分桶:main = 主循环 + 摘要;sub = 【按子 agent 短 id】各自汇总(id 与 /agents、agent-<id>.jsonl 对齐)。
  private usageMain: Usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  private usageSub = new Map<string, Usage>();
  private history: Message[] = [];

  constructor(llm: LLM, opts: AgentOptions = {}) {
    this.llm = llm;
    this.system = opts.system;
    this.tools = opts.tools ?? [];
    this.maxSteps = opts.maxSteps ?? 10;
    this.maxConcurrency =
      opts.maxConcurrency ?? (Number(process.env.AGENT_MAX_CONCURRENCY) || 5);
    this.maxContextTokens = opts.maxContextTokens ?? 100000;
    this.keepRecentTurns = opts.keepRecentTurns ?? 2;
    this.onTextDelta = opts.onTextDelta;
    this.onThinkingDelta = opts.onThinkingDelta;
    this.thinking = opts.thinking;
    this.onToolCall = opts.onToolCall;
    this.onToolResult = opts.onToolResult;
    this.onCompact = opts.onCompact;
    this.onTurnComplete = opts.onTurnComplete;
    this.onApprove = opts.onApprove;
    this.mode = opts.mode ?? initialMode();
  }

  // 权限模式：运行时切换（/mode 命令）与读取（/mode 展示、子 agent 继承）。
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }
  getMode(): PermissionMode {
    return this.mode;
  }

  // 续聊：把磁盘读回来的历史灌进内存（覆盖当前历史）。
  loadHistory(messages: Message[]): void {
    this.history = [...messages];
  }

  // 运行时替换工具集（MCP 热重载用）。
  setTools(tools: Tool[]): void {
    this.tools = tools;
  }

  // 一轮对话（内部可能包含多步工具调用），返回最终的文本回复。
  // opts.signal: 中断信号。中断时不再整轮回滚，而是「封口」成合法状态(业界标准)：
  //   - 流式中中断 → 把已流出的半截文本留成 assistant 消息；
  //   - 工具执行中中断 → 给未完成的 tool_use 补一条 is_error 取消结果。
  // 然后把这条(合法的)轮保留进历史 + 触发 onTurnComplete 落盘，再抛出中断错误。
  async send(
    userInput: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const { signal } = opts;

    // 本轮新增的消息（供持久化）；commit = 同时写进历史和 added。
    const added: Message[] = [];
    const commit = (m: Message) => {
      this.history.push(m);
      added.push(m);
    };
    commit({ role: "user", content: userInput });

    // 跟踪当前阶段，供中断封口判断该补什么。
    let partialText = ""; // 流式阶段已流出的文本
    let pendingToolUses: ToolUseBlock[] | null = null; // 工具阶段：待收尾的 tool_use
    let pendingResults: ToolResultBlock[] = []; // 工具阶段：已收集的结果

    try {
      // agent 循环：每次迭代 = 调一次模型。
      // 「干活」步数 workSteps 受 maxSteps 约束;但【辅助工具】(tool.auxiliary,如 todo
      // 记账)不计入预算 —— 否则「每步都更新 todo」会蚕食步数,让真正干活 + 收尾挤不进
      // 上限(见 docs/14)。另设硬上限 hardLimit(= maxSteps×3),防止模型只调辅助工具
      // 空转死循环(辅助工具不涨 workSteps,光靠它循环不会停)。
      let workSteps = 0;
      const hardLimit = this.maxSteps * 3;
      for (let iter = 0; iter < hardLimit && workSteps < this.maxSteps; iter++) {
        partialText = "";
        pendingToolUses = null;
        pendingResults = [];

        // 调模型前先做上下文管理：历史过长就摘要压缩最旧的对话。
        await this.compactHistory(signal);
        signal?.throwIfAborted();

        // 消费流式生成器：yield 是文本增量(实时显示 + 累积供封口)，
        // done 的 value 是组装好的完整 LLMResponse。
        const it = this.llm.stream(this.history, {
          system: this.effectiveSystem(),
          tools: this.tools,
          signal,
          thinking: this.thinking, // 省略=跟随 LLM env;子 agent 关思考时为 false
          onThinkingDelta: this.onThinkingDelta,
          // 中断兜底:被中断时正常 return 走不到,靠这里补记已烧掉的 usage。
          onUsage: (u) => this.recordMainUsage(u),
        });
        // 收流(边收边显示):onDelta 同时做实时显示 + 累进 partialText;
        // 累积在外层,这样中断抛错时半截文本仍留得住(见下方 catch)。
        const { response: res } = await collectStream(it, (t) => {
          partialText += t;
          this.onTextDelta?.(t);
        });
        this.recordMainUsage(res.usage); // 正常完成:累计本会话用量(含缓存读写),供 /context 观测
        signal?.throwIfAborted();

        // 被 max_tokens 截断 => 这次输出是残缺的，直接报清楚错。
        if (res.stopReason === "max_tokens") {
          throw new Error(
            "输出被 max_tokens 截断（内容或工具调用参数未生成完整）。" +
              "请调大 max_tokens（环境变量 ANTHROPIC_MAX_TOKENS，claude-sonnet-4-6 上限 64000）。",
          );
        }

        const toolUses = res.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        // 没有工具调用 => 最终答复。纯文本存成字符串，更直观。
        if (toolUses.length === 0) {
          const text = extractText(res.content);
          commit({ role: "assistant", content: text });
          this.onTurnComplete?.(added);
          return text;
        }

        // 有工具调用 => 完整存下这一步内容块（含 tool_use，结果靠 id 对应）。
        commit({ role: "assistant", content: res.content });

        // 进入工具阶段：把结果收集成一条 user 消息（tool_result 数组）。
        pendingToolUses = toolUses;
        pendingResults = [];

        // 并行判定(见 docs/16):本轮 >1 个调用【且全是 concurrent 工具】→ 并发跑;
        // 只要混进任何非 concurrent 工具(讲顺序/有副作用)→ 整轮退回串行。
        const allConcurrent =
          toolUses.length > 1 &&
          toolUses.every((c) => this.tools.find((t) => t.name === c.name)?.concurrent);

        if (allConcurrent) {
          // 并发执行,受信号量约束(≤ maxConcurrency 在飞)。allSettled 等所有在飞【落定】
          // (含中断时各自封口);结果按【原索引】回填,与 tool_use 顺序/ id 对应,不因完成
          // 先后错位。某个 execOne 因中断抛出 → 该槽留 null,交下方封口补取消结果。
          const sem = new Semaphore(this.maxConcurrency);
          const slots: (ToolResultBlock | null)[] = toolUses.map(() => null);
          await Promise.allSettled(
            toolUses.map((call, i) =>
              sem.run(() => this.execOne(call, signal)).then((r) => {
                slots[i] = r;
              }),
            ),
          );
          for (const r of slots) if (r) pendingResults.push(r);
          if (slots.some((r) => r === null)) signal?.throwIfAborted();
        } else {
          // 串行(默认):逐个执行,任一中断即抛出交封口。
          for (const call of toolUses) {
            pendingResults.push(await this.execOne(call, signal));
          }
        }

        commit({ role: "user", content: pendingResults });
        pendingToolUses = null;

        // 本轮只要调用了任何【非辅助】工具,就算消耗一个干活步数;
        // 纯辅助轮(只动了 todo 这类记账工具)不计入预算。
        // 未知工具(find 不到)按「干活」算,保守不放水。
        const didWork = toolUses.some(
          (c) => !this.tools.find((t) => t.name === c.name)?.auxiliary,
        );
        if (didWork) workSteps++;
        // 继续下一轮：模型这次能看到工具结果，再决定下一步。
      }

      throw new Error(`超过最大工具调用步数（${this.maxSteps}），可能陷入循环`);
    } catch (err) {
      // 用户中断 => 封口成合法状态并落盘；非中断错误不封口，原样抛出。
      if (signal?.aborted) {
        if (pendingToolUses) {
          // 工具阶段被中断：给未完成的 tool_use 补一条取消结果（业界标准，
          // 保证每个 tool_use 都配对，历史合法、恢复后可正常参与压缩）。
          const done = new Set(pendingResults.map((r) => r.tool_use_id));
          for (const call of pendingToolUses) {
            if (!done.has(call.id)) {
              pendingResults.push({
                type: "tool_result",
                tool_use_id: call.id,
                content: "[已被用户中断]",
                is_error: true,
              });
            }
          }
          commit({ role: "user", content: pendingResults });
        } else if (partialText) {
          // 流式阶段被中断：把已流出的半截文本留下（= ChatGPT 的“停止”）。
          commit({ role: "assistant", content: partialText });
        }
        this.onTurnComplete?.(added);
      }
      throw err;
    }
  }

  // 累加「主桶」用量:主循环 / 摘要 / 后台记忆抽取都算主桶(缺省则跳过)。见第22步。
  // 公开:记忆抽取在 CLI 里调(见 cli.ts),对子 agent 而言这就是它自己 usageMain
  // 的入口——finalizeOnBudget 那次直连 llm 的用量也经此计入。
  recordMainUsage(u?: Usage): void {
    addUsageInto(this.usageMain, u);
  }

  // 记入某个子 agent(按短 id)回传的总用量(由 CLI 的 onSubUsage 调用)。见第22步。
  recordSubUsage(id: string, u?: Usage): void {
    if (!u) return;
    let bucket = this.usageSub.get(id);
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      this.usageSub.set(id, bucket);
    }
    addUsageInto(bucket, u);
  }

  // 本 agent(含摘要)+ 所有子 agent 的合计用量,供外层(如子 agent 回传给上级)读取。
  totalUsage(): Usage {
    const total = { ...this.usageMain };
    for (const u of this.usageSub.values()) addUsageInto(total, u);
    return total;
  }

  // 当前上下文构成，供 /context 等观测用。usage.main = 主循环+摘要;usage.sub = 按子 agent id 分列。
  contextStats(): {
    tokens: number;
    messages: number;
    turns: number;
    hasSummary: boolean;
    maxContextTokens: number;
    usage: { main: Usage; sub: Array<{ id: string; usage: Usage }> };
  } {
    return {
      tokens: estimateTokens(this.history),
      messages: this.history.length,
      turns: countTurns(this.history),
      hasSummary: this.history.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith(SUMMARY_PREFIX),
      ),
      maxContextTokens: this.maxContextTokens,
      usage: {
        main: { ...this.usageMain },
        // Map 保持插入序 → 按「派出先后」列出每个子 agent。
        sub: [...this.usageSub.entries()].map(([id, usage]) => ({ id, usage: { ...usage } })),
      },
    };
  }

  // 上下文管理：历史估算 token 超过软目标 maxContextTokens 时，
  // 把「旧轮」摘要成一段、保留最近 keepRecentTurns 轮逐字;摘要失败回退到整轮截断。
  // 是一次性、尽力而为:压不到软目标(如最近几轮本身就大)也不反复摘、不报错,按现状继续。
  // 注意:摘要只活在内存(磁盘留完整流水,见 docs/09)。
  // TODO: 单条消息过大(超大工具结果/粘贴)轮级摘要缩不动 —— 需消息级压缩
  //       (diff 编辑 / context editing / 读取分页),见 docs/11。
  private async compactHistory(signal?: AbortSignal): Promise<void> {
    const beforeTokens = estimateTokens(this.history);
    if (beforeTokens <= this.maxContextTokens) return;

    const { old, recent } = splitForCompaction(this.history, this.keepRecentTurns);
    if (old.length === 0) return; // 没有可摘要的旧轮(轮数 ≤ K),尽力而为,按现状继续

    let next: Message[];
    let strategy: "summarize" | "truncate";
    let droppedTurns: number;
    try {
      const summary = await this.summarize(old, signal);
      next = [{ role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }, ...recent];
      strategy = "summarize";
      droppedTurns = countTurns(old); // 被折叠进摘要的旧轮数
    } catch (err) {
      if (signal?.aborted) throw err; // 用户中断 => 交给 send 封口，不当作摘要失败
      // 摘要失败(网络等)=> 回退整轮截断,保证 agent 不因摘要挂掉
      next = truncateHistory(this.history, this.maxContextTokens);
      strategy = "truncate";
      droppedTurns = countTurns(this.history) - countTurns(next);
    }

    this.history = next;
    this.onCompact?.({
      strategy,
      droppedTurns,
      beforeTokens,
      afterTokens: estimateTokens(next),
    });
  }

  // 把一段旧消息调一次 LLM 浓缩成摘要文本(无工具、聚焦提示、drain 取文本)。
  private async summarize(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    const transcript = messages
      .map((m) => {
        const text =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${text}`;
      })
      .join("\n");
    const it = this.llm.stream(
      [
        {
          role: "user",
          content:
            "请把下面这段对话浓缩成简洁摘要，保留关键事实、用户偏好、已做的决定和未完成事项，省略寒暄。只输出摘要正文：\n\n" +
            transcript,
        },
      ],
      {
        system: SUMMARY_SYSTEM,
        signal,
        thinking: false, // 摘要是工具调用,不思考(省 token)
        onUsage: (u) => this.recordMainUsage(u), // 中断兜底:同主循环
      },
    );
    const { text, response } = await collectStream(it); // 静默收(含空流兜底)
    this.recordMainUsage(response.usage); // 正常完成:计入本会话
    return text;
  }

  // 安全闸（第24步：权限模式）：判断一个工具调用是否被放行。
  // 返回 null = 放行；返回字符串 = 拒绝（该字符串作为 is_error 结果喂回模型）。
  // 决策 = 当前模式 × 工具类别 → allow|ask|deny：
  //   allow → 直接跑;deny → 不问直接拒(带原因);ask → 看「总是允许」再走 onApprove。
  private async checkPermission(call: ToolUseBlock): Promise<string | null> {
    const tool = this.tools.find((t) => t.name === call.name);
    const category = tool?.category ?? "read"; // 缺省按只读兜底
    const policy = resolvePolicy(this.mode, category);

    if (policy === "allow") return null;
    if (policy === "deny") {
      // 硬拒绝(如 plan 模式禁改/禁执行):无视「总是允许」,回一条带原因的 is_error。
      return `[${this.mode} 模式禁止「${category}」类操作：${call.name}；如需执行，请让用户用 /mode 切换到允许的模式后重试]`;
    }
    // policy === "ask"：本会话已选「总是允许」=> 放行;否则走人工确认。
    if (this.alwaysAllowed.has(call.name)) return null;
    if (!this.onApprove) {
      return `[已拒绝：${call.name} 需人工确认，但未配置审批回调]`;
    }
    const decision = await this.onApprove({ name: call.name, input: call.input });
    if (decision === "always") {
      this.alwaysAllowed.add(call.name);
      return null;
    }
    if (decision === "once") return null;
    return `[用户拒绝执行 ${call.name}]`;
  }

  // 传给 LLM 的实际 system：基线 system 之上追加「当前模式」说明行（default 不追加，
  // 见 permission.modeSystemLine —— 它是基线，模型本按默认行为跑，且保持提示词缓存热路径稳定）。
  private effectiveSystem(): string | undefined {
    const line = modeSystemLine(this.mode);
    if (!line) return this.system;
    return this.system ? `${this.system}\n\n${line}` : line;
  }

  // 执行单个工具调用。出错转成 is_error 结果块让模型纠正；
  // 但「用户中断」(signal.aborted) 例外 —— 上抛给 send 触发整轮回滚，
  // 不喂回一条马上要被回滚的 is_error。
  private async runTool(
    call: ToolUseBlock,
    signal?: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      return { content: `未知工具: ${call.name}`, isError: true };
    }
    try {
      const out = await tool.run(call.input, { signal, readFiles: this.readFiles });
      return { content: String(out), isError: false };
    } catch (err) {
      if (signal?.aborted) throw err; // 用户中断 → 上抛
      return { content: (err as Error).message, isError: true };
    }
  }

  // 执行单个工具调用的【完整一趟】:回调通知 → 安全闸审批 → 真跑 → 回调结果,
  // 产出一条 tool_result。串行/并行两条路都复用它,保证语义一致。
  // 只有「用户中断」会从这里抛出(经 runTool 上抛),交由并发收集 / 封口处理;
  // 其它错误都被 runTool 转成 is_error 结果,不抛。
  private async execOne(
    call: ToolUseBlock,
    signal?: AbortSignal,
  ): Promise<ToolResultBlock> {
    signal?.throwIfAborted();
    this.onToolCall?.({ name: call.name, input: call.input });

    // 安全闸：危险工具执行前要人工确认（除非本会话已选 always）。
    const denial = await this.checkPermission(call);
    if (denial) {
      this.onToolResult?.({ name: call.name, content: denial, isError: true });
      return { type: "tool_result", tool_use_id: call.id, content: denial, is_error: true };
    }

    const { content, isError } = await this.runTool(call, signal);
    this.onToolResult?.({ name: call.name, content, isError });
    return { type: "tool_result", tool_use_id: call.id, content, is_error: isError };
  }

  // 从内容块里抽取纯文本并拼接，作为最终回复字符串。
  // 返回历史副本，避免外部直接改内部数组。
  getHistory(): Message[] {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
    this.readFiles.clear(); // 清空「已读集合」,新会话须重新 read 再 Edit
    this.usageMain = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }; // 缓存用量清零
    this.usageSub.clear();
  }
}
