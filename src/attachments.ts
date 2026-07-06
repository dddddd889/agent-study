import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  AttachmentRefBlock,
  Base64Source,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
} from "./types";

// 附件领域逻辑（第29步）：把「读文件 → 判类型 → 落 blob → 算 token」和「读 blob → base64」
// 收在这一处。不碰 agent、不碰 cli，离线可测。见 CONTEXT.md「附件」、docs/adr/0013。
//
// 设计要点：
//   · blob 仓 = 内容寻址目录 <blobDir>/<sha256>,存字节原文;同图去重、是长期真相。
//   · 历史里只放【ref 块】(轻量引用),base64 只在重放时临时拼出、用完即弃。
//   · 类型识别以【魔数】为准(扩展名仅作候选),不匹配即拒——Office 的 PK 头天然落「不支持」。

// 单文件大小上限（ingest 时校验）。PDF 贴合 API 的 32MB 请求体上限;图片给 5MB。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;

// 单张图片 token 估值封顶（Anthropic 标清 ~1600;高清另说,这里保守封 1600）。
const IMAGE_TOKEN_CAP = 1600;
// 尺寸解析不出时的兜底估值(WebP 等未解析格式)。
const IMAGE_TOKEN_FALLBACK = 1024;
// PDF 每页经验值(文本 + 一张页图的粗估)。
const PDF_TOKENS_PER_PAGE = 1500;

export type AttachmentKind = "image" | "document";

export interface DetectedType {
  kind: AttachmentKind;
  mediaType: string;
}

// ============ 类型守卫 ============
// ref 块与重放后的 image/document 块顶层 type 相同,靠「有没有 ref 字段」区分。
// 收成一处,别让 `"ref" in block` 的裸判断散落 agent/context/compactor。
export function isAttachmentRef(block: ContentBlock): block is AttachmentRefBlock {
  return (block.type === "image" || block.type === "document") && "ref" in block;
}

// 人类可读标签,用于文字标记(蒸馏摘要的 [图片 x.png]、重放缺失的「(已删除)」)。收成一处避免漂移。
export function attachmentLabel(block: AttachmentRefBlock): "图片" | "PDF" {
  return block.type === "document" ? "PDF" : "图片";
}

// ============ 魔数判类型 ============
// 读文件头几字节判真实类型;mediaType 以魔数为准。文件头不匹配任何已知签名 → 抛「不支持」。
export function detectType(bytes: Buffer, path: string): DetectedType {
  const ext = extname(path).toLowerCase();

  // 图片
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIG)) {
    return { kind: "image", mediaType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", mediaType: "image/jpeg" };
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { kind: "image", mediaType: "image/gif" };
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return { kind: "image", mediaType: "image/webp" };
  }
  // PDF：%PDF-
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") {
    return { kind: "document", mediaType: "application/pdf" };
  }

  throw new Error(
    `不支持的附件类型${ext ? `（${ext}）` : ""}：仅支持图片(png/jpg/gif/webp)与 PDF。` +
      `Excel/Word 等请先转成 PDF/CSV。`,
  );
}

// ============ token 估算 ============
// 图片按 Anthropic 公式 ceil(宽×高/750) 封顶;尺寸解析不出则兜底常量。
// PDF 数页 × 每页常量。ingest 时算一次、存进 ref 块,之后估算/压缩直接读、不回碰 blob。
export function estimateTokens(bytes: Buffer, detected: DetectedType): number {
  if (detected.kind === "document") {
    return Math.max(1, countPdfPages(bytes)) * PDF_TOKENS_PER_PAGE;
  }
  const size = imageSize(bytes, detected.mediaType);
  if (!size) return IMAGE_TOKEN_FALLBACK;
  return Math.min(IMAGE_TOKEN_CAP, Math.ceil((size.width * size.height) / 750));
}

// ============ ingest：读文件 → 落 blob → 返回 ref 块 ============
// 此刻文件确定存在(CLI 只对真实文件调此)。把字节【拷进会话 blob 仓】,之后原文件生死不影响会话。
export function ingest(blobDir: string, path: string): AttachmentRefBlock {
  const bytes = readFileSync(path);
  const detected = detectType(bytes, path);

  const limit = detected.kind === "document" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (bytes.length > limit) {
    const mb = (limit / 1024 / 1024).toFixed(0);
    throw new Error(
      `附件过大：${basename(path)} 有 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，` +
        `${detected.kind === "document" ? "PDF" : "图片"}上限 ${mb}MB。`,
    );
  }

  const ref = createHash("sha256").update(bytes).digest("hex");
  const blobPath = join(blobDir, ref);
  if (!existsSync(blobPath)) {
    mkdirSync(blobDir, { recursive: true });
    writeFileSync(blobPath, bytes); // 内容寻址:同 sha256 只写一份(去重)
  }

  return {
    type: detected.kind, // "image" | "document"
    ref,
    name: basename(path),
    mediaType: detected.mediaType,
    tokens: estimateTokens(bytes, detected),
  };
}

// ============ resolveBlob：读 blob → base64（重放用）============
// 只取字节转 base64;mediaType 由调用方从 ref 块自带。blob 缺失(被删/损坏/丢失)返回 null,
// 由重放侧优雅降级成「已删除」文字标记——不抛错。
export function resolveBlob(blobDir: string, ref: string): string | null {
  const blobPath = join(blobDir, ref);
  if (!existsSync(blobPath)) return null;
  return readFileSync(blobPath).toString("base64");
}

// 便利：把 ref 块 + 已读回的 base64 拼成线上 image/document 块（供重放侧用)。
// 按 type 分支返回,让每支拿到字面量类型(image/document 是判别联合,不能用联合 type 直接构造)。
export function toWireBlock(
  block: AttachmentRefBlock,
  base64: string,
): ImageBlock | DocumentBlock {
  const source: Base64Source = { type: "base64", media_type: block.mediaType, data: base64 };
  return block.type === "document"
    ? { type: "document", source }
    : { type: "image", source };
}

// ============ 内部：魔数常量 + 尺寸解析 ============
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("latin1");
}

interface Size {
  width: number;
  height: number;
}

// 从文件头解析图片宽高。PNG/GIF/JPEG 解析;WebP 及解析失败返回 null(交给兜底估值)。
function imageSize(bytes: Buffer, mediaType: string): Size | null {
  try {
    if (mediaType === "image/png") {
      // 8 字节签名 + 4 长度 + 4 "IHDR" 后:width@16、height@20(大端)。
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mediaType === "image/gif") {
      // 6 字节签名后:width@6、height@8(小端)。
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (mediaType === "image/jpeg") {
      return jpegSize(bytes);
    }
  } catch {
    return null;
  }
  return null; // WebP 等:不解析,走兜底
}

// 扫 JPEG 的 SOF 段(FFC0..FFCF,除 FFC4/FFC8/FFCC)取宽高。
function jpegSize(bytes: Buffer): Size | null {
  let i = 2; // 跳过 SOI(FFD8)
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // SOF：i+2 段长(2) + 精度(1) + height(2) + width(2)
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    // 其它段:i+2 处是段长(含自身 2 字节),跳过。
    const segLen = bytes.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return null;
}

// 粗数 PDF 页数：匹配 /Type /Page（不含 /Pages）。数不出按 1 页兜底。
function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![s])/g);
  return matches ? matches.length : 1;
}
