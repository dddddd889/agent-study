import * as readline from "node:readline";
import { Agent } from "./agent";
import { AnthropicLLM } from "./llm";
import { defaultTools } from "./tools";

// 命令行入口：把 agent 循环包进一个 REPL。
// 输入 /exit 退出，/reset 清空对话历史。
// 用 node:readline 而非 `for await (const line of console)`，
// 后者是 Bun 专有 API，在 Node 下不生效。readline 在 Node / Bun 都可用。
async function main() {
  const llm = new AnthropicLLM();
  const agent = new Agent(llm, {
    system:
      "你是一个简洁、友好的中文助手。可以使用工具来获取实时信息、读写文件、发起 HTTP 请求或执行 shell 命令。",
    // defaultTools 含 shell，模型可自动执行任意命令。若有顾虑，可改成
    // tools: defaultTools.filter((t) => t.name !== "shell") 把 shell 摘掉。
    tools: defaultTools,
    // 把工具调用过程打印出来，方便观察 agent 循环里发生了什么。
    onToolCall: ({ name, input }) =>
      console.log(`  · 调用工具 ${name}(${JSON.stringify(input)})`),
    onToolResult: ({ name, content, isError }) =>
      console.log(`  · ${name} ${isError ? "出错" : "结果"}：${content}`),
    // 上下文超限时打印一行，让“agent 遗忘了旧对话”这件事可见。
    onTruncate: ({ droppedTurns, beforeTokens, afterTokens }) =>
      console.log(
        `  · 上下文超限，已遗忘 ${droppedTurns} 轮旧对话（~${beforeTokens} → ~${afterTokens} token）`,
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
      const reply = await agent.send(text);
      console.log(`\nAI > ${reply}\n`);
    } catch (err) {
      console.error(`\n[出错] ${(err as Error).message}\n`);
    }

    rl.prompt();
  }

  rl.close();
  console.log("\n再见！");
}

main();
