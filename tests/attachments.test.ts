import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectType,
  estimateTokens,
  ingest,
  isAttachmentRef,
  resolveBlob,
} from "../src/attachments";
import type { AttachmentRefBlock, ContentBlock } from "../src/types";

const DIR = mkdtempSync(join(tmpdir(), "agent-attach-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

// ============ 构造各格式的最小合法文件头 ============
// PNG：8 字节签名 + IHDR(长度 + "IHDR" + 宽4 + 高4) —— 宽高在 offset 16/20(大端)。
function pngBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
// GIF：签名 + 宽高(小端)@6/8。
function gifBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
// JPEG：SOI(FFD8) + SOF0(FFC0, 段长, 精度, 高2, 宽2)。
function jpegFix(w: number, h: number): Buffer {
  const b = Buffer.alloc(11);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffc0, 2);
  b.writeUInt16BE(8, 4);
  b[6] = 8;
  b.writeUInt16BE(h, 5); // height @ i+5(i=2)
  b.writeUInt16BE(w, 7); // width  @ i+7
  return b;
}
function pdfBytes(pages: number): Buffer {
  let s = "%PDF-1.4\n";
  for (let i = 0; i < pages; i++) s += `<< /Type /Page >>\n`;
  return Buffer.from(s, "latin1");
}
function write(name: string, bytes: Buffer): string {
  const p = join(DIR, name);
  writeFileSync(p, bytes);
  return p;
}

describe("detectType（魔数为准）", () => {
  test("识别 png/jpeg/gif/webp/pdf", () => {
    expect(detectType(pngBytes(1, 1), "a.png")).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    expect(detectType(jpegFix(1, 1), "a.jpg").mediaType).toBe("image/jpeg");
    expect(detectType(gifBytes(1, 1), "a.gif").mediaType).toBe("image/gif");
    const webp = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "latin1"),
    ]);
    expect(detectType(webp, "a.webp").mediaType).toBe("image/webp");
    expect(detectType(pdfBytes(1), "a.pdf")).toEqual({
      kind: "document",
      mediaType: "application/pdf",
    });
  });

  test("伪装扩展名以魔数为准", () => {
    // 实为 PNG，扩展名骗成 .jpg → 仍判 png
    expect(detectType(pngBytes(1, 1), "fake.jpg").mediaType).toBe("image/png");
  });

  test("Office(PK 头) 与随机字节 → 抛不支持", () => {
    const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]); // PK..
    expect(() => detectType(xlsx, "a.xlsx")).toThrow(/不支持/);
    expect(() => detectType(Buffer.from("just text"), "a.txt")).toThrow(/不支持/);
  });
});

describe("estimateTokens", () => {
  test("图片按 ceil(w×h/750) 封顶 1600", () => {
    expect(estimateTokens(pngBytes(75, 100), { kind: "image", mediaType: "image/png" })).toBe(10);
    // 超大图被封顶
    expect(
      estimateTokens(pngBytes(4000, 4000), { kind: "image", mediaType: "image/png" }),
    ).toBe(1600);
  });

  test("尺寸解析不出(webp)走兜底常量", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "latin1"),
    ]);
    expect(estimateTokens(webp, { kind: "image", mediaType: "image/webp" })).toBe(1024);
  });

  test("PDF 按页数 × 每页常量", () => {
    expect(estimateTokens(pdfBytes(3), { kind: "document", mediaType: "application/pdf" })).toBe(
      4500,
    );
  });
});

describe("ingest + resolveBlob", () => {
  test("落 blob 并返回完整 ref 块", () => {
    const path = write("chart.png", pngBytes(75, 150));
    const ref = ingest(DIR, path);
    expect(ref.type).toBe("image");
    expect(ref.name).toBe("chart.png");
    expect(ref.mediaType).toBe("image/png");
    expect(ref.tokens).toBe(15); // 75*150/750
    expect(existsSync(join(DIR, ref.ref))).toBe(true); // blob 落盘
    expect(isAttachmentRef(ref as ContentBlock)).toBe(true);
  });

  test("同内容去重(sha256 只写一份)", () => {
    const a = write("x1.png", pngBytes(10, 10));
    const b = write("x2.png", pngBytes(10, 10)); // 内容相同、文件名不同
    const ra = ingest(DIR, a);
    const before = readdirSync(DIR).filter((f) => f === ra.ref).length;
    const rb = ingest(DIR, b);
    expect(rb.ref).toBe(ra.ref); // 同 sha256
    const after = readdirSync(DIR).filter((f) => f === ra.ref).length;
    expect(before).toBe(1);
    expect(after).toBe(1); // 没有多写
  });

  test("超限抛错", () => {
    const big = write("big.pdf", Buffer.concat([pdfBytes(1), Buffer.alloc(33 * 1024 * 1024)]));
    expect(() => ingest(DIR, big)).toThrow(/过大/);
  });

  test("resolveBlob 往返一致；缺失返回 null", () => {
    const path = write("round.png", pngBytes(20, 20));
    const ref = ingest(DIR, path);
    const b64 = resolveBlob(DIR, ref.ref);
    expect(b64).not.toBeNull();
    // 解码回字节应与原文件一致
    expect(Buffer.from(b64!, "base64").equals(pngBytes(20, 20))).toBe(true);
    // 不存在的 ref → null（删除/损坏的优雅降级基础）
    expect(resolveBlob(DIR, "deadbeef".repeat(8))).toBeNull();
  });
});

describe("isAttachmentRef", () => {
  test("ref 块 true；线上 image 块(带 source) false；text false", () => {
    const ref: AttachmentRefBlock = {
      type: "image",
      ref: "x",
      name: "a.png",
      mediaType: "image/png",
      tokens: 10,
    };
    expect(isAttachmentRef(ref)).toBe(true);
    const wire: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    expect(isAttachmentRef(wire)).toBe(false);
    expect(isAttachmentRef({ type: "text", text: "hi" })).toBe(false);
  });
});
