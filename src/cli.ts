import { existsSync } from "node:fs";
import * as readline from "node:readline";
import { Agent } from "./agent";
import { AnthropicLLM } from "./llm";
import { extractMemory, readMemory, writeMemory } from "./memory";
import { loadMcpTools, type McpServerInfo } from "./mcp";
import {
  appendMessages,
  listSessions,
  listSubagents,
  loadSession,
  newSessionId,
} from "./session";
import {
  createCriticTool,
  createDispatchAgentTool,
  DISPATCH_TOOL_NAME,
} from "./subagent";
import { latestTodos, renderTodos } from "./todo";
import { defaultTools } from "./tools";
import type { Tool } from "./types";

// 子 agent 显示配色(第16步):每个【新出现】的子 agent 按顺序分到下一个调色板颜色,
// 保证同时出现的多个子 agent 颜色互不相同(超过调色板数量才回卷);同一 id 本会话内恒定同色。
// 10 色全避开报错用的红。仅在真终端(TTY)上色;被重定向/管道时输出纯文本,不污染日志。
const SUB_COLORS = [36, 32, 33, 35, 34, 96, 92, 93, 95, 94];
const subColorOf = new Map<string, number>();
let subColorNext = 0;
const colorForId = (id: string): number => {
  let c = subColorOf.get(id);
  if (c === undefined) {
    c = SUB_COLORS[subColorNext++ % SUB_COLORS.length]!;
    subColorOf.set(id, c);
  }
  return c;
};
// 只给传入的片段上色(就是 ▓<id> 这个身份标记),正文保持默认色。
const paintSub = (id: string, s: string): string =>
  process.stdout.isTTY ? `\x1b[${colorForId(id)}m${s}\x1b[0m` : s;

// 命令行入口：把 agent 循环包进一个 REPL。
// 输入 /exit 退出，/reset 清空对话历史。
// 用 node:readline 而非 `for await (const line of console)`，
// 后者是 Bun 专有 API，在 Node 下不生效。readline 在 Node / Bun 都可用。
async function main() {
  const llm = new AnthropicLLM({
    // 网络/网关抖动（502、429、5xx）时自动重试，并把过程打印出来。
    // 前导 \n：避免和正在流式输出的文本黏在同一行。
    onRetry: ({ attempt, maxRetries, status, error, delayMs }) =>
      console.log(
        `\n  · 请求失败（${status ?? error?.message ?? "网络错误"}），` +
          `${(delayMs / 1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`,
      ),
  });
  // 会话 id：启动带参 = 续聊该会话；不带 = 新建。/new 会换成新 id。
  // onTurnComplete 闭包读取的是 sessionId 这个 let 变量的“当前值”，所以 /new 后能切到新文件。
  let sessionId = process.argv[2] ?? newSessionId();

  // 放行模式：AGENT_ALLOW_ALL=1 时危险工具自动允许、不弹问。
  // 仅供本地无人值守等场景，慎用 —— shell 会裸跑任意命令。
  const allowAll = process.env.AGENT_ALLOW_ALL === "1";

  // 长期记忆：会话开始时把 .memory.md 注入系统提示（跨会话沉淀的事实/偏好/决定）。
  // 末段是第14步的【规划引导】:规划能力主要来自这段提示 + todo_write 工具(见 docs/14)。
  const baseSystem =
    "你是一个简洁、友好的中文助手。可以使用工具来获取实时信息、读写文件、发起 HTTP 请求或执行 shell 命令。\n\n" +
    "检索优先用专用工具、别用 shell:找文件用 glob(如 src/**/*.ts)、搜内容用 grep(正则),它们更稳、输出规整、自动跳过 node_modules/.gitignore。" +
    "改文件优先用 edit_file(精确替换),整文件重写才用 write_file,跨多文件的批量改动(含增删文件)用 apply_patch(原子)。" +
    "shell 只留给检索/读写之外的事(跑测试、git 等),不要用 shell 的 find/grep/ls/cat 来找文件或读文件。\n\n" +
    "处理需要多步骤的任务时,先用 todo_write 把目标拆成清单再动手;" +
    "每开始一项就把它标为 in_progress、做完立刻标 completed,同一时刻最多一项 in_progress;" +
    "计划有变就重发完整清单。简单的一两步任务不必用。\n\n" +
    "遇到【独立、边界清晰】的子任务(尤其会产生大量中间过程的,如「读若干文件并总结」" +
    "「调研某库用法」),可用 dispatch_agent 交给子 agent 隔离执行、只收回结论,避免这些过程占满你的上下文。" +
    "务必把子任务所需的【完整背景】写进 prompt —— 子 agent 看不到当前对话。\n\n" +
    "重要 / 易错 / 有可验证产物的产出,完成后可用 critic 请一个隔离审查者自查:" +
    "【同时】给它 task(原始任务)和 output(产出),有代码/文件就在 artifacts 里给路径。" +
    "拿到裁定后,【只为 `[严重]` 问题返工】、修完再复审,最多约两轮;`[次要]` 可带注记直接交付,别死磕。" +
    "平凡确定的操作(ls、看时间、单次读取)不必审查 —— 审查有成本,别滥用。";
  const memory = readMemory();
  const system = memory ? `${baseSystem}\n\n[长期记忆]\n${memory}` : baseSystem;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 当前回合的中断控制器；非 null 表示「正在回复中」。
  let currentAbort: AbortController | null = null;

  // 读一行：rl 关闭时 resolve null（用于空闲 Ctrl+C 退出）。
  // 用显式 ask() 而非 `for await (const line of rl)`，这样审批弹问可以在回合中途
  // 嵌套调用 rl.question 而不和主循环抢输入（同一时刻只有一个问题在等）。
  // 读一行；rl 关闭或 signal abort 时 resolve null。
  // 统一结算 settle：幂等(只生效一次) + 集中清理监听，避免重复 resolve / 泄漏。
  const ask = (q: string, signal?: AbortSignal): Promise<string | null> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(null);
      let settled = false;
      const settle = (v: string | null) => {
        if (settled) return;
        settled = true;
        rl.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onClose = () => settle(null);
      const onAbort = () => settle(null);
      rl.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      // 把 signal 传给 readline：abort 时它会取消这个 question，
      // 不再吃掉用户随后输入的行。
      rl.question(q, { signal }, (answer) => settle(answer));
    });

  // prompt(提示符)= readline 等输入时打印在行首的那串文字,这里就是 `你 > `。
  // 后台输出(如 MCP 就绪概况)是直接往终端写字符,会糊在用户正敲的 `你 >` 行上、冲乱它;
  // 打印完调 rl.prompt(true) 把提示符重画一遍 —— preserveCursor=true 连同已敲的半行内容
  // 一起保留(不清屏、不丢输入),终端保持整洁。
  // 仅在空闲时重画:回合中(模型回复 / 审批弹问)提示符不是 "你 >",别插手。
  const redrawPrompt = () => {
    if (currentAbort) return;
    rl.prompt(true);
  };

  // Ctrl+C：回合中 => 中断本轮；空闲 => 关闭 rl（ask 返回 null → 退出）。
  // 不能在回合期间 rl.pause()，否则 readline 读不到 Ctrl+C 按键。
  rl.on("SIGINT", () => {
    if (currentAbort) currentAbort.abort();
    else rl.close();
  });

  // MCP:在【后台】连接 .mcp.json 里的 server,不阻塞 REPL 启动。
  // mcp 句柄初始为空,连好后替换 + setTools;mcpReady 跟踪后台加载,供 /exit 等待。
  let mcp: Awaited<ReturnType<typeof loadMcpTools>> = {
    tools: [],
    close: async () => {},
    servers: [],
  };
  const printMcp = (servers: McpServerInfo[]) => {
    if (!servers.length) {
      console.log("（无 MCP server；在 .mcp.json 配置 mcpServers 后用 /mcp reload 加载）");
      return;
    }
    for (const s of servers) {
      // 显示注册给模型的实际名字(带 <server>__ 前缀),和模型调用时一致。
      const names = s.toolNames.map((t) => `${s.name}__${t}`).join(", ");
      console.log(
        s.ok
          ? `  ${s.name} (${s.transport}) ✓  ${s.toolNames.length} 个工具: ${names}`
          : `  ${s.name} (${s.transport}) ✗  ${s.error}`,
      );
    }
  };

  // 审批期间「定住」输出(第16步):并行下,当一个子 agent 正弹审批、等你回答时,其它并行
  // 子 agent 仍在跑、仍会打日志,会把审批提示行冲掉。于是审批一旦挂起(approvalPending),
  // 其它工具/子 agent 的日志先【缓冲】进 held,等审批结束再一次性放出来,保证提示行不被覆盖。
  let approvalPending = false;
  const held: string[] = [];
  const emit = (line: string): void => {
    if (approvalPending) held.push(line);
    else console.log(line);
  };
  const flushHeld = (): void => {
    for (const l of held) console.log(l);
    held.length = 0;
  };

  // 危险工具审批(第10步):主 agent 与子 agent【共享】同一回调 + 同一「本会话总是允许」集合。
  // 这样在主 agent 里对某工具选过 [a]总是,子 agent 再用它就不重复弹问(见 docs/15 · Q7)。
  // 复用 ask()，回合中按 Ctrl+C(abort) → ans 为 null → 当作拒绝。放行模式下全部允许、不弹问。
  const sessionAllowed = new Set<string>();
  // 审批串行化(第16步):并行子 agent 可能同时请求审批,用一把异步锁保证【一次只弹一个】
  // 问题、不抢同一个 readline stdin;顺带消除 sessionAllowed 的「查-问-加」竞态(见 docs/16)。
  // 链式实现:每个请求排在前一个之后,前者无论成败都放行下一个。
  let approveChain: Promise<unknown> = Promise.resolve();
  const withApprovalLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = approveChain.then(fn, fn);
    approveChain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const onApprove = allowAll
    ? async () => "always" as const
    : ({ name, input }: { name: string; input: Record<string, unknown> }) =>
        withApprovalLock(async () => {
          if (sessionAllowed.has(name)) return "always" as const; // 已总是允许,不再打断
          approvalPending = true; // 定住其它并行子 agent 的日志,别冲掉下面的提示行
          try {
            const ans = await ask(
              `\n  ⚠ 允许执行 ${name}(${JSON.stringify(input)})? [y]一次 /[a]总是 /[n]拒绝 `,
              currentAbort?.signal,
            );
            const c = (ans ?? "").trim().toLowerCase()[0];
            if (c === "a") {
              sessionAllowed.add(name);
              return "always" as const;
            }
            return c === "y" ? ("once" as const) : ("deny" as const);
          } finally {
            approvalPending = false;
            flushHeld(); // 审批结束,把期间缓冲的日志按序放出来
          }
        });

  // 子 agent(第15步):dispatch_agent 就是又一个普通工具。getSessionId 闭包读当前 sessionId
  // (/new 后自动切目录);currentTools 返回当前全集(含 MCP 热重载),子 agent 在此基础上剔除
  // dispatch_agent 自己(禁递归)。子 agent 的过程带 └ 缩进打印,与主 agent 的输出层级分明。
  const getSessionId = () => sessionId;
  let dispatchTool: Tool;
  let criticTool: Tool;
  const currentTools = (): Tool[] => [
    ...defaultTools,
    dispatchTool,
    criticTool,
    ...mcp.tools,
  ];
  // dispatch_agent 与 critic 共享同一套依赖(取工具集 / 会话 id / 审批 / 显示回调)。
  const subDeps = {
    llm,
    getTools: currentTools,
    getSessionId,
    onApprove,
    // 子 agent 启动:主层(█)打一条,按角色区分「请 critic 审查」/「派出 <角色> 子 agent」。
    onSubStart: (id: string, prompt: string, roleType: string) =>
      emit(
        `\n█ ${roleType === "critic" ? "请 critic 审查" : `派出 ${roleType} 子 agent`} ${paintSub(id, `▓${id}`)}：${prompt.replace(/\s+/g, " ")}`,
      ),
    // 子 agent 过程:缩进(深度1)+ 灰度块 ▓ + 短 id;【只给 ▓<id> 标记上色】,正文默认色。
    // 并行交织时,靠这个彩色标记一眼分清是哪个子 agent(docs/16)。经 emit:审批期间先缓冲。
    onSubToolCall: (id: string, { name, input }: { name: string; input: Record<string, unknown> }) =>
      emit(`\n  ${paintSub(id, `▓${id}`)} 调用 ${name}(${JSON.stringify(input)})`),
    onSubToolResult: (id: string, { name, content, isError }: { name: string; content: string; isError: boolean }) =>
      emit(`  ${paintSub(id, `▓${id}`)} ${name} ${isError ? "出错" : "结果"}：${content}`),
  };
  dispatchTool = createDispatchAgentTool(subDeps);
  criticTool = createCriticTool(subDeps);

  const agent = new Agent(llm, {
    system,
    // 每轮的消息提交到历史时追加落盘（append-only）。
    onTurnComplete: (added) => appendMessages(sessionId, added),
    // 上下文软上限：默认 100000；设 AGENT_MAX_CONTEXT_TOKENS 调小可观察压缩(摘要)。
    maxContextTokens: Number(process.env.AGENT_MAX_CONTEXT_TOKENS) || undefined,
    // 干活步数上限：默认 10(辅助工具如 todo 不计入)；大任务用 AGENT_MAX_STEPS 调大。
    maxSteps: Number(process.env.AGENT_MAX_STEPS) || undefined,
    // 本地工具 + dispatch_agent(子 agent)+ MCP 外部工具(危险工具执行前走 onApprove 确认)。
    tools: currentTools(),
    // 模型回复的文本增量，边生成边裸写到终端（不加换行）。
    onTextDelta: (text) => process.stdout.write(text),
    // 把工具调用过程打印出来，方便观察 agent 循环里发生了什么。
    // dispatch_agent 例外：它的启动由 onSubStart 打「派出子 agent ▓<id>」更清晰,这里跳过,
    // 免得再重复一条冗长(含完整 prompt)的通用行,并行时更是徒增交织噪音。
    onToolCall: ({ name, input }) => {
      if (name === DISPATCH_TOOL_NAME) return;
      emit(`\n█ 调用工具 ${name}(${JSON.stringify(input)})`);
    },
    onToolResult: ({ name, content, isError }) =>
      emit(`█ ${name} ${isError ? "出错" : "结果"}：${content}`),
    onCompact: ({ strategy, droppedTurns, beforeTokens, afterTokens }) =>
      console.log(
        `\n  · 上下文压缩(${strategy === "summarize" ? "摘要" : "截断"})：${droppedTurns} 轮旧对话（~${beforeTokens} → ~${afterTokens} token）`,
      ),
    onApprove,
  });

  // MCP 后台加载:不阻塞 REPL。连好后替换句柄 + setTools + 打印就绪概况。
  // mcpReady 跟踪在飞的加载(供 /exit、/mcp reload 等待);mcpLoaded 标记是否已就绪。
  const mcpConfigured = existsSync(process.env.AGENT_MCP_CONFIG ?? ".mcp.json");
  let mcpReady: Promise<void> = Promise.resolve();
  let mcpLoaded = !mcpConfigured;
  const loadMcp = () => {
    mcpReady = loadMcpTools()
      .then((h) => {
        mcp = h;
        mcpLoaded = true;
        agent.setTools(currentTools());
        if (h.servers.length) {
          process.stdout.write("\n  · MCP 已就绪：\n");
          printMcp(h.servers);
          redrawPrompt(); // 概况打印完,重新亮出 `你 >`(含已敲内容)
        }
      })
      .catch(() => {
        mcpLoaded = true;
      });
  };

  // 长期记忆：每轮后【后台】更新，不阻塞主对话。
  // 单飞(running 防重叠)+ 吞错(后台失败不影响对话)；退出时 flush。
  let memoryRunning = false;
  let lastMemoryRun: Promise<void> = Promise.resolve();
  const updateMemory = () => {
    if (memoryRunning) return; // 单飞：一次没跑完不重叠;下次读全量历史会补上
    memoryRunning = true;
    lastMemoryRun = (async () => {
      try {
        const next = await extractMemory(llm, agent.getHistory(), readMemory());
        if (next) writeMemory(next); // 空结果不覆盖,避免清空记忆
      } catch {
        // 后台失败：静默,不影响主对话
      } finally {
        memoryRunning = false;
      }
    })();
  };

  // 续聊：启动带了 sessionId 且磁盘有记录 → 灌进内存接着聊。
  if (process.argv[2]) {
    const prior = loadSession(sessionId);
    if (prior.length) {
      agent.loadHistory(prior);
      console.log(`已恢复会话 ${sessionId}（${prior.length} 条消息）`);
    } else {
      console.log(`会话 ${sessionId} 暂无记录，作为新会话开始`);
    }
  } else {
    console.log(`新会话 ${sessionId}`);
  }

  if (allowAll) {
    console.log(
      "⚠ 放行模式(AGENT_ALLOW_ALL=1)：所有危险工具将自动执行、不再确认。",
    );
  }

  console.log(
    "命令：/exit · /reset · /sessions · /new · /context · /memory · /todo · /agents · /mcp [reload]",
  );

  // 提示符已可立即出现;MCP 在后台连(连好再打印就绪概况、再可用)。
  if (mcpConfigured) console.log("· MCP 连接中…(后台)");
  console.log("");
  loadMcp();

  while (true) {
    const line = await ask("你 > ");
    if (line === null) break; // rl 已关闭（空闲时 Ctrl+C）
    const text = line.trim();

    if (text === "/exit") break;
    if (text === "/reset") {
      agent.reset();
      console.log("（已清空对话历史）\n");
      continue;
    }
    if (text === "/sessions") {
      const list = listSessions();
      if (!list.length) console.log("（暂无会话）\n");
      else {
        for (const s of list) {
          const cur = s.id === sessionId ? " ←当前" : "";
          console.log(
            `  ${s.id}  ${s.updatedAt.toLocaleString()}  ${s.preview.slice(0, 20)}${cur}`,
          );
        }
        console.log(`\n（续聊某会话：重启时 bun run src/cli.ts <id>）\n`);
      }
      continue;
    }
    if (text === "/new") {
      sessionId = newSessionId();
      agent.reset();
      console.log(`已开新会话 ${sessionId}\n`);
      continue;
    }
    if (text === "/context") {
      const s = agent.contextStats();
      console.log(
        `上下文：~${s.tokens} token · ${s.messages} 条消息 · ${s.turns} 轮 · 含摘要 ${s.hasSummary ? "✓" : "✗"} · 软上限 ${s.maxContextTokens}\n`,
      );
      continue;
    }
    if (text === "/memory") {
      const m = readMemory();
      console.log(m ? `[长期记忆]\n${m}\n` : "(暂无长期记忆)\n");
      continue;
    }
    if (text === "/todo") {
      // 当前清单从历史解析(唯一真相 = history),和模型看到的是同一份。
      const todos = latestTodos(agent.getHistory());
      console.log(todos.length ? `[当前任务]\n${renderTodos(todos)}\n` : "(暂无任务清单)\n");
      continue;
    }
    if (text === "/agents") {
      // 列出本会话派出过的子 agent(从 .sessions/<主id>/agents/ 存档解析)。
      const list = listSubagents(sessionId);
      if (!list.length) console.log("(本会话暂无子 agent 记录)\n");
      else {
        for (const a of list) {
          console.log(
            `  ${paintSub(a.id, `▓${a.id}`)}  ${a.messages} 条消息  ${a.preview.slice(0, 30)}`,
          );
        }
        console.log(`\n（完整存档：.sessions/${sessionId}/agents/agent-<id>.jsonl）\n`);
      }
      continue;
    }
    if (text === "/mcp") {
      if (!mcpLoaded) console.log("MCP 连接中…(后台,稍候)"); // 还没连好
      else printMcp(mcp.servers);
      console.log("");
      continue;
    }
    if (text === "/mcp reload") {
      await mcpReady; // 等后台首连结束,避免和 reload 抢句柄
      await mcp.close(); // 关旧连接(kill 子进程 / 关会话)
      mcp = await loadMcpTools(); // 重读 .mcp.json、重连
      agent.setTools(currentTools()); // 运行时换工具集(dispatch_agent + 新 MCP)
      console.log("已重载 MCP：");
      printMcp(mcp.servers);
      console.log("");
      continue;
    }
    if (text === "") continue;

    currentAbort = new AbortController();
    try {
      process.stdout.write("\nAI > ");
      const reply = await agent.send(text, { signal: currentAbort.signal });
      process.stdout.write("\n");
      if (reply.trim() === "") {
        console.log("(本轮无文本输出，可能是工具失败后模型未给结论)");
      }
      process.stdout.write("\n");
    } catch (err) {
      if (currentAbort.signal.aborted) {
        process.stdout.write("\n(已中断)\n\n"); // 用户按了 Ctrl+C
      } else {
        console.error(`\n[出错] ${(err as Error).message}\n`);
      }
    } finally {
      currentAbort = null;
    }

    // 一轮结束：后台更新长期记忆，不 await（不阻塞下一句输入）。
    updateMemory();
  }

  // 退出前 flush：等在飞的记忆更新，再补跑一次以纳入最后一轮（尽力而为）。
  await lastMemoryRun;
  if (agent.getHistory().length > 0) {
    process.stdout.write("正在保存长期记忆…\n");
    try {
      const next = await extractMemory(llm, agent.getHistory(), readMemory());
      if (next) writeMemory(next);
    } catch {
      // 退出时记忆保存失败：忽略
    }
  }

  await mcpReady; // 后台首连可能还在飞,先等它落定再关,避免漏关子进程
  await mcp.close(); // 关闭所有 MCP 连接(kill 子进程 / 关会话)
  rl.close();
  console.log("\n再见！");
}

main();
