import { describe, expect, test } from "bun:test";
import { serializeForDistill } from "../src/context";
import type { Message } from "../src/types";

// 第30步:skill 三层蒸馏。dropSkill 只对【长期记忆抽取】为 true(剔 skill 正文),
// 对【摘要压缩】为 false(保留)。标记只盖 skill 正文、不盖意图。见 docs/adr/0014。

describe("serializeForDistill dropSkill：剔/留 skill 正文", () => {
  // 用户通道:整条 user 消息带 skillMark。模型通道:tool_result 块带 skillMark。
  const history: Message[] = [
    { role: "user", content: "帮我审查代码" }, // 用户意图(无标记)
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "skill", input: { name: "code-review" } }],
    },
    // 模型通道:skill 正文作 tool_result,带块级 skillMark。
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "SKILL 正文:第一步…第二步…", skillMark: "code-review" },
      ],
    },
    { role: "assistant", content: "审查完成，发现两个问题" },
    // 用户通道:整条消息是 skill 正文,带消息级 skillMark。
    { role: "user", content: "USER 通道 skill 正文", skillMark: "my-flow" },
  ];

  test("dropSkill:true → skill 正文(两条通道)都不出现", () => {
    const out = serializeForDistill(history, { dropSkill: true });
    expect(out).not.toContain("SKILL 正文");
    expect(out).not.toContain("USER 通道 skill 正文");
  });

  test("dropSkill:true → 用户意图与普通对话仍保留(标记只盖正文)", () => {
    const out = serializeForDistill(history, { dropSkill: true });
    expect(out).toContain("帮我审查代码"); // 用户原话/意图
    expect(out).toContain("审查完成，发现两个问题"); // 普通 assistant 轮
  });

  test("dropSkill:false(及默认) → skill 正文照常保留", () => {
    const out = serializeForDistill(history, { dropSkill: false });
    expect(out).toContain("SKILL 正文");
    expect(out).toContain("USER 通道 skill 正文");
    expect(serializeForDistill(history)).toContain("SKILL 正文"); // 默认 = 保留
  });

  test("同轮批量:只剔 skill 那一块，不误伤同批别的工具结果", () => {
    const batched: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "普通工具结果 ABC", is_error: false },
          { type: "tool_result", tool_use_id: "b", content: "SKILL 正文 XYZ", skillMark: "s" },
        ],
      },
    ];
    const out = serializeForDistill(batched, { dropSkill: true });
    expect(out).toContain("普通工具结果 ABC"); // 同批别的结果保留
    expect(out).not.toContain("SKILL 正文 XYZ"); // 只剔 skill 块
  });

  test("既有行为不变:思考块仍被剔", () => {
    const withThinking: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "内部草稿不该出现", signature: "sig" },
          { type: "text", text: "正式答复" },
        ],
      },
    ];
    const out = serializeForDistill(withThinking, { dropSkill: true });
    expect(out).not.toContain("内部草稿");
    expect(out).toContain("正式答复");
  });
});
