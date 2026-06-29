import * as readline from "node:readline";
import { Agent } from "./agent";
import { AnthropicLLM } from "./llm";

// 命令行入口：把 agent 循环包进一个 REPL。
// 输入 /exit 退出，/reset 清空对话历史。
// 用 node:readline 而非 `for await (const line of console)`，
// 后者是 Bun 专有 API，在 Node 下不生效。readline 在 Node / Bun 都可用。
async function main() {
  const llm = new AnthropicLLM();
  const agent = new Agent(llm, {
    system: "你是一个简洁、友好的中文助手。",
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
