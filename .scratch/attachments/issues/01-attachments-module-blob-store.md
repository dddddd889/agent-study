# 01 attachments 模块 + ref 块 + blob 仓

Status: ready-for-agent

参见 [PRD](../PRD.md) · [ADR-0013](../../../docs/adr/0013-attachments-content-addressed-blob-store.md)

## 背景

附件的全部领域逻辑收在一个新模块 `src/attachments.ts`，与内容块类型定义（`types.ts`）。这一层不碰 agent、不碰 CLI，离线可测。

## 范围

**`src/types.ts`**：给 `ContentBlock` 联合加两种块，照抄 Anthropic API 形状：

```ts
// 图片块。source 三选一(base64/url/file),本步只落 base64;历史里以 ref 块形态存在。
export interface ImageBlock { type: "image"; source: ImageSource; }
// PDF 块。与 image 并列(API 对二者处理不同),source 结构相同。
export interface DocumentBlock { type: "document"; source: DocumentSource; }
// 附件 ref 块(历史/落盘形态):不含 base64,只存内容寻址引用 + 元信息 + token 估值。
export interface AttachmentRefBlock {
  type: "image" | "document";
  ref: string;        // sha256
  name: string;       // 原文件名,供文字标记/展示
  mediaType: string;  // 以魔数为准
  tokens: number;     // ingest 时算好,供 estimateTokens 直接读
}
```

`ContentBlock` 加入 `ImageBlock | DocumentBlock | AttachmentRefBlock`（ref 块是历史/wire 的存在形态，image/document 的 base64 形态只在重放时临时出现）。

**`src/attachments.ts`**：

1. `detectType(bytes, path) → { kind: "image"|"document"; mediaType }`：扩展名先给候选，**魔数核对**（PNG `89 50 4E 47`、JPEG `FF D8 FF`、GIF `47 49 46`、WebP `52 49 46 46...WEBP`、PDF `25 50 44 46`）。`mediaType` 以魔数为准；文件头不匹配任何已知签名 → 抛「不支持」错误（Office 的 `PK` 头天然落这里）。
2. `estimateTokens(bytes, kind, mediaType) → number`：图读宽高（PNG IHDR / JPEG SOF）算 `ceil(w*h/750)` 封顶；PDF 数页（`/Type /Page` 或 `/Count`）× 每页常量。
3. `ingest(blobDir, path) → AttachmentRefBlock`：读字节 → 大小校验（图 ~5MB / PDF ~32MB，超则抛错）→ `detectType` → sha256 → `blobDir/<sha256>` 不存在则写 → 算 token → 返回 ref 块。
4. `resolveBlob(blobDir, ref) → { mediaType; data: base64 }`：读 `blobDir/<ref>` 编码成 base64。给重放侧（issue 02）用。

## 验收标准

- `detectType`：四类图片 + PDF 各识别正确；扩展名与魔数不符时以魔数为准；`.xlsx`/`.docx`（`PK` 头）与随机字节 → 抛「不支持」。
- `ingest`：同一文件调两次只写一份 blob（sha256 去重）；超限文件抛错；返回的 ref 块字段完整（含正确 `tokens`）。
- `resolveBlob`：对 ingest 落的 blob 能还原出与原文件一致的字节（base64 解码后比对）。
- 纯模块，不引入对 `agent.ts` / `cli.ts` 的依赖。

## 测试

`tests/attachments.test.ts`：魔数识别（含伪装扩展名、Office 头拒绝）、sha256 去重、大小上限、token 估算（给定尺寸图片断言公式）、ingest→resolveBlob 往返一致。用临时目录作 `blobDir`。
