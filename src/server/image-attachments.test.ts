import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sendMessageRequestSchema } from "../protocol.js";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ImageAttachmentValidationError,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_REQUEST_BASE64_CHARS,
  validateImageAttachments,
} from "./image-attachments.js";

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00, 0xff, 0xd9,
]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function pngBytes(width = 1, height = 1, data = Buffer.from([0])): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", data),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_BYTES = pngBytes();
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x05, 0x00, 0x00, 0x00,
  0x2f, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function attachment(mimeType: string, bytes: Buffer): { type: "image"; mimeType: string; data: string } {
  return { type: "image", mimeType, data: bytes.toString("base64") };
}

function expectInvalid(value: unknown): void {
  expect(() => validateImageAttachments(value)).toThrow(ImageAttachmentValidationError);
}

describe("validateImageAttachments", () => {
  it("accepts JPEG, PNG, and WebP attachments and returns decoded bytes", () => {
    const inputs = [
      attachment("image/jpeg", JPEG_BYTES),
      attachment("image/png", PNG_BYTES),
      attachment("image/webp", WEBP_BYTES),
    ];

    const validated = validateImageAttachments(inputs);

    expect(ALLOWED_IMAGE_MIME_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(validated).toHaveLength(3);
    for (let index = 0; index < validated.length; index += 1) {
      expect(validated[index]).toMatchObject(inputs[index]!);
      expect(validated[index]!.bytes).toEqual([JPEG_BYTES, PNG_BYTES, WEBP_BYTES][index]);
      expect(validated[index]!.id).toMatch(/^image_[a-f0-9]{64}$/);
    }
  });

  it("rejects signature-only and truncated image containers", () => {
    expectInvalid([attachment("image/jpeg", Buffer.from([0xff, 0xd8, 0xff]))]);
    expectInvalid([attachment("image/png", PNG_BYTES.subarray(0, 8))]);
    expectInvalid([attachment("image/webp", WEBP_BYTES.subarray(0, 12))]);
  });

  it("rejects invalid PNG checksums and duplicate critical structure", () => {
    const badChecksum = Buffer.from(PNG_BYTES);
    badChecksum[badChecksum.length - 1] ^= 0x01;
    expectInvalid([attachment("image/png", badChecksum)]);

    const duplicateHeader = Buffer.concat([
      PNG_BYTES.subarray(0, 33),
      PNG_BYTES.subarray(8, 33),
      PNG_BYTES.subarray(33),
    ]);
    expectInvalid([attachment("image/png", duplicateHeader)]);
  });

  it("rejects excessive dimensions, per-image pixels, and request pixels", () => {
    expectInvalid([attachment("image/png", pngBytes(MAX_IMAGE_DIMENSION + 1, 1))]);

    const tooManyPixels = Buffer.from(JPEG_BYTES);
    tooManyPixels.writeUInt16BE(5_000, 7);
    tooManyPixels.writeUInt16BE(10_000, 9);
    expectInvalid([attachment("image/jpeg", tooManyPixels)]);

    const thirtyMegapixels = Buffer.from(JPEG_BYTES);
    thirtyMegapixels.writeUInt16BE(5_000, 7);
    thirtyMegapixels.writeUInt16BE(6_000, 9);
    expectInvalid(Array.from({ length: 3 }, () => attachment("image/jpeg", thirtyMegapixels)));
  });

  it("turns accessor and proxy failures into safe validation errors", () => {
    let accessed = false;
    const accessor = { type: "image", mimeType: "image/png" } as Record<string, unknown>;
    Object.defineProperty(accessor, "data", {
      enumerable: true,
      get() { accessed = true; return PNG_BYTES.toString("base64"); },
    });
    expectInvalid([accessor]);
    expect(accessed).toBe(false);

    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expectInvalid(proxy);
  });

  it("accepts an empty attachment list", () => {
    expect(validateImageAttachments([])).toEqual([]);
  });

  it("creates stable content-addressed IDs from the MIME type and bytes", () => {
    const input = attachment("image/png", PNG_BYTES);
    const first = validateImageAttachments([input])[0]!;
    const second = validateImageAttachments([{ ...input }])[0]!;
    const expectedDigest = createHash("sha256").update("image/png").update(PNG_BYTES).digest("hex");

    expect(first.id).toBe(`image_${expectedDigest}`);
    expect(second.id).toBe(first.id);

    const changedBytes = pngBytes(1, 1, Buffer.from([1]));
    expect(validateImageAttachments([attachment("image/png", changedBytes)])[0]!.id).not.toBe(first.id);
  });

  it.each([
    ["JPEG bytes labeled as PNG", "image/png", JPEG_BYTES],
    ["PNG bytes labeled as WebP", "image/webp", PNG_BYTES],
    ["WebP bytes labeled as JPEG", "image/jpeg", WEBP_BYTES],
  ])("rejects spoofed MIME content: %s", (_label, mimeType, bytes) => {
    expectInvalid([attachment(mimeType, bytes)]);
  });

  it.each([
    ["empty", ""],
    ["bad alphabet", "/9j_AA=="],
    ["embedded whitespace", "/9j/ AA="],
    ["missing padding", "/9j/AA"],
    ["excess padding", "/9j/AA==="],
    ["non-canonical padding bits", "/9j/AB=="],
  ])("rejects %s base64", (_label, data) => {
    expectInvalid([{ type: "image", mimeType: "image/jpeg", data }]);
  });

  it("requires an array", () => {
    for (const value of [null, undefined, {}, "not-an-array", 1]) expectInvalid(value);
  });

  it("requires exactly the type, mimeType, and data fields", () => {
    const valid = attachment("image/png", PNG_BYTES);
    expectInvalid([{ mimeType: valid.mimeType, data: valid.data }]);
    expectInvalid([{ ...valid, extra: true }]);
    expectInvalid([{ ...valid, type: "file" }]);
    expectInvalid([{ ...valid, mimeType: "image/gif" }]);
    expectInvalid([{ ...valid, data: 123 }]);
    expectInvalid([null]);
  });

  it("rejects more than the maximum attachment count", () => {
    const valid = attachment("image/png", PNG_BYTES);
    expect(MAX_IMAGE_ATTACHMENTS).toBe(3);
    expectInvalid(Array.from({ length: MAX_IMAGE_ATTACHMENTS + 1 }, () => ({ ...valid })));
  });

  it("rejects an encoded image above the per-image limit", () => {
    const oversized = "A".repeat(MAX_IMAGE_BASE64_CHARS + 4);
    expectInvalid([{ type: "image", mimeType: "image/jpeg", data: oversized }]);
  });

  it("accepts images at the per-image and total encoded limits", () => {
    expect(MAX_IMAGE_REQUEST_BASE64_CHARS).toBe(MAX_IMAGE_ATTACHMENTS * MAX_IMAGE_BASE64_CHARS);

    const decodedLength = (MAX_IMAGE_BASE64_CHARS / 4) * 3;
    const bytes = Buffer.alloc(decodedLength);
    JPEG_BYTES.copy(bytes);
    bytes.set([0xff, 0xd9], bytes.length - 2);
    const atLimit = attachment("image/jpeg", bytes);
    expect(atLimit.data).toHaveLength(MAX_IMAGE_BASE64_CHARS);

    const validated = validateImageAttachments(Array.from({ length: MAX_IMAGE_ATTACHMENTS }, () => ({ ...atLimit })));
    expect(validated).toHaveLength(MAX_IMAGE_ATTACHMENTS);
  });

  it("uses safe errors that do not echo rejected data", () => {
    const secretMarker = "private-input-marker";
    let thrown: unknown;
    try {
      validateImageAttachments([{ type: "image", mimeType: "image/png", data: secretMarker }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ImageAttachmentValidationError);
    expect((thrown as Error).message).not.toContain(secretMarker);
  });
});


describe("sendMessageRequestSchema image contract", () => {
  const base = { requestId: "00000000-0000-4000-8000-000000000001", expectedRevision: 1 };

  it("accepts image-only requests and supplies an empty image list for text requests", () => {
    const imageOnly = sendMessageRequestSchema.safeParse({
      ...base,
      text: "",
      images: [attachment("image/jpeg", JPEG_BYTES)],
    });
    expect(imageOnly.success).toBe(true);

    const textOnly = sendMessageRequestSchema.parse({ ...base, text: " hello " });
    expect(textOnly).toMatchObject({ text: "hello", images: [] });
  });

  it("rejects empty messages and unknown image fields", () => {
    expect(sendMessageRequestSchema.safeParse({ ...base, text: "", images: [] }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({
      ...base,
      text: "image",
      images: [{ ...attachment("image/jpeg", JPEG_BYTES), name: "local-name.jpg" }],
    }).success).toBe(false);
  });
});
