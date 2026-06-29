import * as readline from "node:readline";
import { Agent } from "./agent";
import { AnthropicLLM } from "./llm";
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
  const agent = new Agent(llm, {
    system:
      "你是一个简洁、友好的中文助手。可以使用工具来获取实时信息、读写文件、发起 HTTP 请求或执行 shell 命令。",
    // defaultTools 含 shell，模型可自动执行任意命令。若有顾虑，可改成
    // tools: defaultTools.filter((t) => t.name !== "shell") 把 shell 摘掉。
    tools: defaultTools,
    // 模型回复的文本增量，边生成边裸写到终端（不加换行）。
    onTextDelta: (text) => process.stdout.write(text),
    // 把工具调用过程打印出来，方便观察 agent 循环里发生了什么。
    // 前导 \n：和正在流式输出的文本分行。
    onToolCall: ({ name, input }) =>
      console.log(`\n  · 调用工具 ${name}(${JSON.stringify(input)})`),
    onToolResult: ({ name, content, isError }) =>
      console.log(`  · ${name} ${isError ? "出错" : "结果"}：${content}`),
    // 上下文超限时打印一行，让“agent 遗忘了旧对话”这件事可见。
    onTruncate: ({ droppedTurns, beforeTokens, afterTokens }) =>
      console.log(
        `\n  · 上下文超限，已遗忘 ${droppedTurns} 轮旧对话（~${beforeTokens} → ~${afterTokens} token）`,
      ),
  });

  console.log("简易对话 Agent 已启动。输入 /exit 退出，/reset 重置对话。\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "你 > ",
  });
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();

    if (text === "/exit") break;
    if (text === "/reset") {
      agent.reset();
      console.log("（已清空对话历史）\n");
      rl.prompt();
      continue;
    }
    if (text === "") {
      rl.prompt();
      continue;
    }

    try {
      // 回合期间暂停 readline 输入：避免 AI 还在流式回复时用户抢着打字，
      // 导致输入被缓冲、提示符与流式输出交错。结束后在 finally 里恢复。
      rl.pause();
      // 流式：先打印前缀，回复内容由 onTextDelta 边到边写出，结束后补换行。
      // 不再打印 send() 的返回值（否则会和流式内容重复）。
      process.stdout.write("\nAI > ");
      const reply = await agent.send(text);
      process.stdout.write("\n");
      // 模型以 end_turn 收场却没产出任何文本（常见于工具失败后直接放弃），
      // 补一句说明，免得“静默结束”看起来像卡住 / 答案被截断。
      if (reply.trim() === "") {
        console.log("(本轮无文本输出，可能是工具失败后模型未给结论)");
      }
      process.stdout.write("\n");
    } catch (err) {
      console.error(`\n[出错] ${(err as Error).message}\n`);
    } finally {
      rl.resume();
    }

    rl.prompt();
  }

  rl.close();
  console.log("\n再见！");
}

main();
