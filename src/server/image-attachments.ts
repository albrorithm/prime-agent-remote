import { createHash } from "node:crypto";
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_ATTACHMENTS as SHARED_MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARS as SHARED_MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_REQUEST_BASE64_CHARS as SHARED_MAX_IMAGE_REQUEST_BASE64_CHARS,
  type ImageMimeType,
} from "../protocol.js";

export const ALLOWED_IMAGE_MIME_TYPES = IMAGE_MIME_TYPES;
export const MAX_IMAGE_ATTACHMENTS = SHARED_MAX_IMAGE_ATTACHMENTS;
export const MAX_IMAGE_BASE64_CHARS = SHARED_MAX_IMAGE_BASE64_CHARS;
export const MAX_IMAGE_REQUEST_BASE64_CHARS = SHARED_MAX_IMAGE_REQUEST_BASE64_CHARS;

export type AllowedImageMimeType = ImageMimeType;

export interface ValidatedImageAttachment {
  type: "image";
  mimeType: AllowedImageMimeType;
  data: string;
  bytes: Buffer;
  id: string;
}

export class ImageAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachmentValidationError";
  }
}

const REQUIRED_FIELDS = new Set(["type", "mimeType", "data"]);
const BASE64_SYNTAX = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");

function fail(message: string): never {
  throw new ImageAttachmentValidationError(message);
}

function isAllowedMimeType(value: unknown): value is AllowedImageMimeType {
  return typeof value === "string" && ALLOWED_IMAGE_MIME_TYPES.some((mimeType) => mimeType === value);
}

function hasExactFields(value: object): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === REQUIRED_FIELDS.size
    && keys.every((key) => typeof key === "string" && REQUIRED_FIELDS.has(key));
}

function decodeCanonicalBase64(data: string): Buffer {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_SYNTAX.test(data)) {
    return fail("Invalid image attachment data.");
  }

  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== data) {
    return fail("Invalid image attachment data.");
  }
  return bytes;
}

function hasJpegStructure(bytes: Buffer): boolean {
  if (bytes.length < 24 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset + 3 < bytes.length - 2) {
    while (offset < bytes.length - 2 && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length - 2) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (offset + 2 > bytes.length - 2) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return false;
    if (startOfFrameMarkers.has(marker)) {
      if (length < 8) return false;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 32_768 || height > 32_768) return false;
      sawFrame = true;
    }
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    offset += length;
  }
  return sawFrame && sawScan;
}

function hasPngStructure(bytes: Buffer): boolean {
  if (bytes.length < 57 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > 32_768 || height > 32_768) return false;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (length === 0) return false;
      sawData = true;
    } else if (type === "IEND") {
      return length === 0 && sawData && chunkEnd === bytes.length;
    }
    offset = chunkEnd;
  }
  return false;
}

function hasWebpStructure(bytes: Buffer): boolean {
  if (bytes.length < 26 || !bytes.subarray(0, 4).equals(RIFF_SIGNATURE)
    || !bytes.subarray(8, 12).equals(WEBP_SIGNATURE)
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  let sawImageData = false;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkLength + (chunkLength % 2);
    if (chunkEnd > bytes.length) return false;
    if (chunkType === "VP8L") {
      if (chunkLength < 5 || bytes[dataOffset] !== 0x2f) return false;
      const dimensions = bytes.readUInt32LE(dataOffset + 1);
      const width = (dimensions & 0x3fff) + 1;
      const height = ((dimensions >>> 14) & 0x3fff) + 1;
      if (width > 32_768 || height > 32_768) return false;
      sawImageData = true;
    } else if (chunkType === "VP8 ") {
      if (chunkLength < 10 || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) return false;
      const width = bytes.readUInt16LE(dataOffset + 6) & 0x3fff;
      const height = bytes.readUInt16LE(dataOffset + 8) & 0x3fff;
      if (width < 1 || height < 1) return false;
      sawImageData = true;
    } else if (chunkType === "VP8X") {
      if (chunkLength < 10) return false;
      const width = 1 + bytes.readUIntLE(dataOffset + 4, 3);
      const height = 1 + bytes.readUIntLE(dataOffset + 7, 3);
      if (width > 32_768 || height > 32_768) return false;
    }
    offset = chunkEnd;
  }
  return sawImageData && offset === bytes.length;
}

function hasMatchingImageStructure(mimeType: AllowedImageMimeType, bytes: Buffer): boolean {
  switch (mimeType) {
    case "image/jpeg": return hasJpegStructure(bytes);
    case "image/png": return hasPngStructure(bytes);
    case "image/webp": return hasWebpStructure(bytes);
  }
}

function imageId(mimeType: AllowedImageMimeType, bytes: Buffer): string {
  const digest = createHash("sha256").update(mimeType).update(bytes).digest("hex");
  return `image_${digest}`;
}

export function validateImageAttachments(attachments: unknown): ValidatedImageAttachment[] {
  if (!Array.isArray(attachments)) return fail("Image attachments must be an array.");
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) return fail("Too many image attachments.");

  const validated: ValidatedImageAttachment[] = [];
  let totalBase64Chars = 0;

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment: unknown = attachments[index];
    if (attachment === null || typeof attachment !== "object" || Array.isArray(attachment) || !hasExactFields(attachment)) {
      return fail("Invalid image attachment.");
    }

    const { type, mimeType, data } = attachment as Record<string, unknown>;
    if (type !== "image" || !isAllowedMimeType(mimeType) || typeof data !== "string") {
      return fail("Invalid image attachment.");
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) return fail("Image attachment is too large.");

    totalBase64Chars += data.length;
    if (totalBase64Chars > MAX_IMAGE_REQUEST_BASE64_CHARS) {
      return fail("Image attachments are too large.");
    }

    const bytes = decodeCanonicalBase64(data);
    if (!hasMatchingImageStructure(mimeType, bytes)) {
      return fail("Image attachment content does not match its MIME type.");
    }

    validated.push({ type, mimeType, data, bytes, id: imageId(mimeType, bytes) });
  }

  return validated;
}
