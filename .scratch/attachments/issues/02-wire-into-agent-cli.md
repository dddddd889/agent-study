# 02 接入主链路：send 收块 / agent 重放 / CLI @路径 ingest

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0013](../../../docs/adr/0013-attachments-content-addressed-blob-store.md) · 依赖 [issue 01](01-attachments-module-blob-store.md)

## 背景

把 issue 01 的模块接进「用户 → 模型」通道。三处改动，守住两条不变量：`agent.ts` 不碰文件系统、`llm.ts` 纯透传。

## 范围

**`src/agent.ts`**：

1. `send` 签名放宽：`send(input: string | ContentBlock[], opts)`。传字符串行为不变；传块数组直接 `commit({role:"user", content: input})`。
2. 注入 `blobResolver?: (ref: string) => { mediaType: string; data: string } | null`（走 `AgentOptions`，同 `onCompact`/`onToolResult` 的依赖注入风格）；**blob 缺失时返回 `null`，不抛错**。
3. **重放**：调 `llm.stream()` 前，把要发送的消息映射成一份临时 **wire 副本**——遇到 ref 块用 `blobResolver` 换成 `{type, source:{type:"base64", media_type, data}}`；`this.history` 不动。wire 副本传给 llm，用完即弃（不缓存）。agent 全程不认路径、只调注入的函数。
4. **缺失优雅降级**：`blobResolver` 返回 `null`（blob 被删 / 文件损坏 / 丢失）时，把该 ref 块换成 **text 块** `[图片 <name>（已删除）]` / `[PDF <name>（已删除）]`，而非报错或发出坏块。这既是健壮性（blob 损坏不炸），也是"删附件"的落地方式——删掉 blob 文件即让该图从此不可见（ref 成墓碑，历史仍合法）。

**`src/cli.ts`**：

1. 解析用户输入里的 `@路径`：仅当解析出的路径**真实存在**才当附件，否则原样留在文本里（`@types` 之类不误伤）。
2. 对每个附件路径调 `attachments.ingest(blobDir, path)`（`blobDir = .sessions/<sessionId>/blobs/`，不存在则建）；拼出 `[text块, ref块...]` 传给 `agent.send`。ingest 抛错（不支持类型 / 超限）→ 打印明确提示、跳过该附件。
3. 构造 Agent 时注入 `blobResolver = (ref) => attachments.resolveBlob(blobDir, ref)`。

**`src/session.ts`**：确认 ref 块随现有 JSONL 读写天然往返（content 是块数组，本就支持）；blob 目录在会话目录下、删会话时一并清理。

## 验收标准

- 纯文本输入：行为与今天完全一致（回归）。
- `你 > 看看 @fixtures/x.png` → 该图 base64 出现在发给 llm 的请求里；`this.history` 与 `<id>.jsonl` 里只有 ref 块（无 base64）。
- blob 落在 `.sessions/<id>/blobs/<sha256>`；续聊读回历史后，重放仍能从 blob 还原图片。
- `@不存在的路径` / `@types` → 当普通文字，不报错、不当附件。
- 不支持类型 / 超限 → CLI 明确提示并跳过，不中断输入。
- **blob 缺失降级**：手动删掉某个 blob 文件后续聊 / 重放 → 该 ref 换成 `[图片 x.png（已删除）]` text 块，不报错、不发坏块；其它附件不受影响。
- `agent.ts` 无 `fs`/路径引用；`llm.ts` 未改。

## 测试

- `tests/agent.test.ts`：`send(ContentBlock[])` 提交含 ref 块的 user 轮；带 `blobResolver` 时发给 FakeLLM 的消息里 ref 块已换成 base64 块，且 `getHistory()` 里仍是 ref 块。
- `tests/session.test.ts`：含 ref 块的历史 JSONL 往返一致。
