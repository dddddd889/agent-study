---
Status: accepted
---

# 用户消息附件：内容寻址 blob 仓 + ref 块 + 用完即弃的重放

## 决策

给「用户 → 模型」通道加**本地图片 / PDF 附件**。用户在 REPL 里用 `@路径` 挂文件；CLI 解析后 `ingest` 成**内容寻址 blob**（`.sessions/<id>/blobs/<sha256>` 存字节），历史与 JSONL 里只存**轻量 ref 块** `{type, ref:sha256, name, mediaType, tokens}`。喂 API 前经注入的 `blobResolver` 把 ref **重放**成 API 的 base64 `image`/`document` 块，**用完即弃、不缓存**。

- **内容块（Q2）**：照抄 Anthropic API 的两种块——图片 `image`、PDF `document`，共享 `source`（base64/url/file，本步只用 base64）。不合成自定义「media」块。
- **边界（Q3）**：仅图片(png/jpg/gif/webp) + PDF、仅本地文件；其余（Excel/Office、URL）**明确拒绝**并提示，不静默塞乱码。
- **语法（Q4）**：行内 `@路径`，只认真实存在的文件，否则当普通文字。
- **持久化（Q5/Q6）**：内容寻址 blob 仓，每会话独占、随删会话一起没、不单独 GC、同图 sha256 去重、仅主 agent。
- **重放（Q7）**：注入 `blobResolver`、agent 不碰 fs、`llm.ts` 纯透传；base64 只在一次调用期间存在于临时 wire 副本，发完即 GC。
- **类型识别（Q9）**：扩展名筛 + 魔数核对，`media_type` 以魔数为准，不匹配即拒。
- **上限（Q10）**：单文件 图~5MB / PDF~32MB、单条消息 ≤10 个，ingest 时校验。
- **压缩 / 长期记忆（Q11）**：**所有把历史蒸馏成文本的 LLM 子调用**（摘要压缩 + 长期记忆抽取）都把附件→文字标记 `[图片 x.png]`（同 thinking 剔除）。收成一处 `context.serializeForDistill`,compactor 与 memory 共用,避免两个蒸馏点漂移。图片**不做急切剔除**,随压缩窗口统一淘汰;冻结后原图不可见（已知局限）。
- **token（Q12）**：ingest 时按 `w×h/750`（图）/ 页数×常量（PDF）算一次、存进 ref 块，估算/压缩直接读、不碰 blob。
- **删除（Q13）**：不加显式命令。批量删 = 删会话（blobs 随之没）；抹某张图 = 删其 blob 文件（ref 成墓碑，因流水 append-only 不可改写）。使二者成立的核心是**重放对缺失 blob 优雅降级**：`blobResolver` 读不到 blob 返回 `null`，重放把该 ref 换成 text 块 `[图片 x.png（已删除）]`，不报错、不发坏块。

## 为什么这样

- **base64 避不开，但不该常驻**：API 请求体必然带 base64（还 ~1.33× 于原字节）。真正的选择是「这坨要不要跨调用留在内存」。内存缓存会随对话出现过的不同图片**无界增长**；改成**每次现读现编、用完即弃**，稳态内存里只有轻量 ref。代价是同一张图在其仍处「最近 K 轮」窗口内的几轮会被重复读盘+编码——本地读几 MB 很快，且完全契合既有「派生物丢了就重算」的心智。
- **压缩天然给内存与成本封顶**：带图旧轮老化出最近 K 轮窗口即冻结成文字标记，base64 再不重建。所以每次调用真正重放的图**只限最近 K 轮**，不是整条历史——活跃 footprint 有界。这也是「不做急切剔除」成立的原因：追问「再看那张图」在 K 轮内可成，成本又被窗口框住；急切剔除（对标 `clear_tool_uses`）省更多 token 但**静默**牺牲回看能力，留 TODO。
- **blob 仓 vs 内联 vs 路径引用（Q5）**：内联 base64 进 JSONL 让单行几 MB，膨胀读回/预览/压缩都拖着它；路径引用把「唯一真相」让渡给用户可能移动/删除的外部文件，脆。内容寻址 blob 仓两头兼得——流水精简（重物挪出主流水，像 sidecar 那样）**且**自包含（blob 归会话所有，不依赖原文件），去重是白捡红利。呼应 docs/09「原始流水唯一真相」：blob 是会话自己的资产、不是外部依赖。
- **两条不变量不动**：`agent.ts` 不碰 fs（重放靠注入回调，磁盘知识全在 CLI + `attachments.ts`）；`llm.ts` 纯透传（重放在 agent 侧把 ref 换 base64，llm 只管发块数组）。附件因此没在这两个核心模块引入文件系统耦合。
- **照抄 API 两种块而非自造抽象**：其它 ContentBlock 全是 1:1 映射 API；image 与 document 语义/计费本就是两条路（PDF 服务端拆逐页文本+页图），合成一个 media 块反要在透传处写翻译层——违背既有简洁。统一体验放在**输入层**（用户只管 `@文件`，按魔数分派），不放在内容块层。

## 边界与考量

- **蒸馏用标记而非生成 caption**：摘要那次是纯文本 LLM 调用、看不见图，没法描述它。而图的语义通常已沉淀在最近 K 轮里 assistant 聊它的文本中（会被喂进摘要器），标记只需标出「曾有图」。生成 caption 要额外视觉调用、是「急着干可能用不上」的浪费，留 TODO。已知局限：用户贴图但模型没就它说过话就走远 → 冻结后该图内容丢失（只剩文件名）。
- **B 工具结果返图不在本步**：那要把 `ToolResultBlock.content` 从 `string` 放宽成块数组，波及每个工具的返回契约与结果收集逻辑，是独立更大的一步。本步是纯「用户 → 模型」单向通道，工具契约不动。
- **token 估算本地粗算而非 count_tokens**：沿用 `estimateTokens` 既有「粗估 + TODO 精确化」路子（[context.ts](../context.ts) 已有此 TODO），不为附件引入联网/额度成本。按 `w×h/750` 读头解析，比拍常量更能反映真实大小。
- **子 agent 不支持附件**：子 agent 不续聊、走结构化派活，附件入口是另一码事，留 TODO。
- **轮起点判定（`isUserInput`）改判据**（实现时发现）：原判据是「`role==="user"` 且 content 是**字符串**」——但带附件的用户输入 content 是 `ContentBlock[]`（text + ref 块），会被误判成非轮起点，导致压缩找不到切点、轮数漏计。改成「user 且**不是 tool_result 消息**」：user 消息只有两类（真实输入 / 工具结果回传），排除后者即得轮起点。纯文本仍走字符串快路,附件轮与工具结果靠「有没有 tool_result 块」区分。这维持了「切点只在真实用户输入」的整轮不变量([[历史保真]])。
- **删除靠降级而非改写历史（Q13）**：流水 append-only 是铁律，ref 块进了某轮就删不掉——所以"删附件"删的是 **blob 字节**、ref 留作**墓碑**，对标 Anthropic 记忆版本的 `redact`（留痕迹、抹内容）。blob 内容寻址 + 去重，删一个 blob 影响所有引用它的 ref——这正是"把这张图彻底抹掉"想要的语义。缺失降级路径本就为健壮性（blob 损坏 / 丢失）需要，顺带让删除只是 `rm` 一个文件的事。**显式删除命令**（`/attach rm`）与**blob GC**（回收游标之后不再被引用的 blob——冻结轮已是文字标记、不引用 blob，故安全）都留 TODO：有了降级路径，将来加它们无需返工。

## 落地

见 PRD [.scratch/attachments/PRD.md](../../.scratch/attachments/PRD.md) 与其 issues。核心：新 `src/attachments.ts`（detectType/ingest/resolveBlob，魔数、sha256、大小校验、token 估算）+ `types.ts` 加 image/document/ref 块；`agent.ts` 的 `send` 收 `string | ContentBlock[]`、注入 `blobResolver` 重放；`cli.ts` 解析 `@路径`→ingest→拼块、注入 resolver、`/context` 加附件计数；`context.ts` 估算读 ref 块 `tokens`,并新增共享的 `serializeForDistill`(剔思考 + 附件转标记);`compactor.ts` 与 `memory.ts`(长期记忆抽取)都复用它,不再各写一份。术语见 CONTEXT.md「附件（多模态输入）」。
