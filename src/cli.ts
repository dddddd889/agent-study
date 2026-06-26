import { Agent } from "./agent";
import { AnthropicLLM } from "./llm";

// 命令行入口：把 agent 循环包进一个 REPL。
// 输入 /exit 退出，/reset 清空对话历史。
async function main() {
  const llm = new AnthropicLLM();
  const agent = new Agent(llm, {
    system: "你是一个简洁、友好的中文助手。",
  });

  console.log("简易对话 Agent 已启动。输入 /exit 退出，/reset 重置对话。\n");

  const prompt = "你 > ";
  process.stdout.write(prompt);

  for await (const line of console) {
    const text = line.trim();

    if (text === "/exit") break;
    if (text === "/reset") {
      agent.reset();
      console.log("（已清空对话历史）\n");
      process.stdout.write(prompt);
      continue;
    }
    if (text === "") {
      process.stdout.write(prompt);
      continue;
    }

    try {
      const reply = await agent.send(text);
      console.log(`\nAI > ${reply}\n`);
    } catch (err) {
      console.error(`\n[出错] ${(err as Error).message}\n`);
    }

    process.stdout.write(prompt);
  }

  console.log("\n再见！");
}

main();
