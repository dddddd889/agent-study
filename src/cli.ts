import * as readline from "node:readline";
import { Agent } from "./agent";
import { AnthropicLLM } from "./llm";
import { extractMemory, readMemory, writeMemory } from "./memory";
import {
  appendMessages,
  listSessions,
  loadSession,
  newSessionId,
} from "./session";
import { defaultTools } from "./tools";

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
  const baseSystem =
    "你是一个简洁、友好的中文助手。可以使用工具来获取实时信息、读写文件、发起 HTTP 请求或执行 shell 命令。";
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

  // Ctrl+C：回合中 => 中断本轮；空闲 => 关闭 rl（ask 返回 null → 退出）。
  // 不能在回合期间 rl.pause()，否则 readline 读不到 Ctrl+C 按键。
  rl.on("SIGINT", () => {
    if (currentAbort) currentAbort.abort();
    else rl.close();
  });

  const agent = new Agent(llm, {
    system,
    // 每轮的消息提交到历史时追加落盘（append-only）。
    onTurnComplete: (added) => appendMessages(sessionId, added),
    // 上下文软上限：默认 100000；设 AGENT_MAX_CONTEXT_TOKENS 调小可观察压缩(摘要)。
    maxContextTokens: Number(process.env.AGENT_MAX_CONTEXT_TOKENS) || undefined,
    // defaultTools 含 shell 等危险工具；执行前会走 onApprove 人工确认。
    tools: defaultTools,
    // 模型回复的文本增量，边生成边裸写到终端（不加换行）。
    onTextDelta: (text) => process.stdout.write(text),
    // 把工具调用过程打印出来，方便观察 agent 循环里发生了什么。
    onToolCall: ({ name, input }) =>
      console.log(`\n  · 调用工具 ${name}(${JSON.stringify(input)})`),
    onToolResult: ({ name, content, isError }) =>
      console.log(`  · ${name} ${isError ? "出错" : "结果"}：${content}`),
    onCompact: ({ strategy, droppedTurns, beforeTokens, afterTokens }) =>
      console.log(
        `\n  · 上下文压缩(${strategy === "summarize" ? "摘要" : "截断"})：${droppedTurns} 轮旧对话（~${beforeTokens} → ~${afterTokens} token）`,
      ),
    // 危险工具执行前弹问；复用 ask()，回合中按 Ctrl+C(abort) → ans 为 null → 当作拒绝。
    // 放行模式下直接全部允许，不弹问。
    onApprove: allowAll
      ? async () => "always"
      : async ({ name, input }) => {
          const ans = await ask(
            `\n  ⚠ 允许执行 ${name}(${JSON.stringify(input)})? [y]一次 /[a]总是 /[n]拒绝 `,
            currentAbort?.signal,
          );
          const c = (ans ?? "").trim().toLowerCase()[0];
          return c === "y" ? "once" : c === "a" ? "always" : "deny";
        },
  });

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
    "命令：/exit · /reset 清空 · /sessions · /new · /context 看上下文 · /memory 看长期记忆\n",
  );

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

  rl.close();
  console.log("\n再见！");
}

main();
