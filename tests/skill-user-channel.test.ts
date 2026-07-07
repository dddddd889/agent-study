import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { countTurns, serializeForDistill } from "../src/context";
import { decodeJsonl, encodeJsonl } from "../src/jsonl";
import type { Message } from "../src/types";
import { FakeLLM } from "./fake-llm";

// 第30步 用户通道 /<name>:send(body, {prelude:[原话], skillMark:name}) 注入两条 user 消息 ——
// 原话【不打标】(进长期记忆,保住意图),正文【打标】(剔长期记忆)。见 docs/adr/0014。

describe("agent.send 用户通道:prelude + skillMark", () => {
  test("注入两条消息:原话不打标、正文打标；模型据此回复", async () => {
    const llm = new FakeLLM(() => "已按 skill 流程完成");
    const agent = new Agent(llm, { tools: [] });

    await agent.send("SKILL 正文:审查步骤…", {
      prelude: [{ role: "user", content: "/code-review src/a.ts" }],
      skillMark: "code-review",
    });

    const history = agent.getHistory();
    // 前两条应为:原话(user, 无 skillMark) + 正文(user, skillMark=code-review)。
    const prelude = history[0]!;
    const body = history[1]!;
    expect(prelude.role).toBe("user");
    expect(prelude.content).toBe("/code-review src/a.ts");
    expect(prelude.skillMark).toBeUndefined();
    expect(body.role).toBe("user");
    expect(body.content).toBe("SKILL 正文:审查步骤…");
    expect(body.skillMark).toBe("code-review");
    // 之后是 assistant 回复。
    expect(history[2]?.role).toBe("assistant");
  });

  test("端到端:长期记忆蒸馏剔除 skill 正文、保留用户意图", async () => {
    const llm = new FakeLLM(() => "done");
    const agent = new Agent(llm, { tools: [] });
    await agent.send("SKILL 正文机密流程", {
      prelude: [{ role: "user", content: "/foo 帮我做 X" }],
      skillMark: "foo",
    });

    const history: Message[] = agent.getHistory();
    // 长期记忆(dropSkill:true):正文剔除、用户意图保留。
    const forMemory = serializeForDistill(history, { dropSkill: true });
    expect(forMemory).not.toContain("SKILL 正文机密流程");
    expect(forMemory).toContain("/foo 帮我做 X"); // 用户意图进记忆
    // 摘要压缩(dropSkill:false):正文照常保留。
    const forSummary = serializeForDistill(history, { dropSkill: false });
    expect(forSummary).toContain("SKILL 正文机密流程");
  });

  test("轮数不虚涨:原话+正文两条 user 消息只算一轮", async () => {
    const llm = new FakeLLM(() => "done");
    const agent = new Agent(llm, { tools: [] });
    await agent.send("正文", {
      prelude: [{ role: "user", content: "/foo x" }],
      skillMark: "foo",
    });
    // 历史 = [原话(user), 正文(user,skillMark), assistant]。skill 正文不算轮起点 → 仅 1 轮。
    expect(countTurns(agent.getHistory())).toBe(1);
  });

  test("skillMark 经 JSONL 往返保真(续聊)", () => {
    const msgs: Message[] = [
      { role: "user", content: "/foo x" },
      { role: "user", content: "正文", skillMark: "foo" },
      { role: "assistant", content: "ok" },
    ];
    const back = decodeJsonl<Message>(encodeJsonl(msgs));
    expect(back[0]!.skillMark).toBeUndefined();
    expect(back[1]!.skillMark).toBe("foo"); // 标记随流水落盘、读回不丢
    expect(back[1]!.content).toBe("正文"); // 正文原样(流水唯一真相)
  });
});
