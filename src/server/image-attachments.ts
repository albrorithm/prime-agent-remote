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
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_REQUEST_PIXELS = 80_000_000;

export type AllowedImageMimeType = ImageMimeType;

export interface ValidatedImageAttachment {
  type: "image";
  mimeType: AllowedImageMimeType;
  data: string;
  bytes: Buffer;
  id: string;
}

interface ImageDimensions {
  width: number;
  height: number;
  pixels: number;
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
const PNG_CHUNK_TYPE = /^[A-Za-z]{4}$/u;
const PNG_ALLOWED_BIT_DEPTHS = new Map<number, Set<number>>([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function fail(message: string): never {
  throw new ImageAttachmentValidationError(message);
}

function isAllowedMimeType(value: unknown): value is AllowedImageMimeType {
  return typeof value === "string" && ALLOWED_IMAGE_MIME_TYPES.some((mimeType) => mimeType === value);
}

function readAttachmentFields(value: unknown): { type: unknown; mimeType: unknown; data: unknown } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== REQUIRED_FIELDS.size
    || !keys.every((key) => typeof key === "string" && REQUIRED_FIELDS.has(key))) return null;
  for (const key of REQUIRED_FIELDS) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  return {
    type: descriptors.type!.value,
    mimeType: descriptors.mimeType!.value,
    data: descriptors.data!.value,
  };
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

function dimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return null;
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) return null;
  return { width, height, pixels };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let frameDimensions: ImageDimensions | null = null;
  while (offset + 3 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length - 2) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (marker === 0xd9 || offset + 2 > bytes.length - 2) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (frameDimensions || length < 11) return null;
      const precision = bytes[offset + 2];
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7]!;
      if ((precision !== 8 && precision !== 12) || components < 1 || components > 4 || length !== 8 + 3 * components) return null;
      frameDimensions = dimensions(width, height);
      if (!frameDimensions) return null;
    }
    if (marker === 0xda) {
      if (!frameDimensions || length < 8) return null;
      const components = bytes[offset + 2]!;
      if (components < 1 || components > 4 || length !== 6 + 2 * components) return null;
      return offset + length < bytes.length - 2 ? frameDimensions : null;
    }
    offset += length;
  }
  return null;
}

function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 57 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  let offset = PNG_SIGNATURE.length;
  let imageDimensions: ImageDimensions | null = null;
  let colorType: number | null = null;
  let sawPalette = false;
  let sawData = false;
  let dataEnded = false;
  let totalDataBytes = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) return null;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!PNG_CHUNK_TYPE.test(type) || (bytes[offset + 6]! & 0x20) !== 0) return null;
    if (crc32(bytes, offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) return null;

    if (!imageDimensions) {
      if (type !== "IHDR" || length !== 13) return null;
      imageDimensions = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      if (!imageDimensions) return null;
      const bitDepth = bytes[offset + 16]!;
      colorType = bytes[offset + 17]!;
      if (!PNG_ALLOWED_BIT_DEPTHS.get(colorType)?.has(bitDepth)
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0
        || (bytes[offset + 20] !== 0 && bytes[offset + 20] !== 1)) return null;
    } else if (type === "IHDR") {
      return null;
    } else if (type === "PLTE") {
      if (sawPalette || sawData || colorType === 0 || colorType === 4
        || length === 0 || length % 3 !== 0 || length > 768) return null;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (colorType === 3 && !sawPalette)) return null;
      sawData = true;
      totalDataBytes += length;
    } else if (type === "IEND") {
      return length === 0 && sawData && totalDataBytes > 0 && chunkEnd === bytes.length
        ? imageDimensions
        : null;
    } else {
      if (sawData) dataEnded = true;
      // Unknown critical chunks are not safe to interpret. Ancillary chunks are allowed.
      if ((bytes[offset + 4]! & 0x20) === 0) return null;
    }
    offset = chunkEnd;
  }
  return null;
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 26 || !bytes.subarray(0, 4).equals(RIFF_SIGNATURE)
    || !bytes.subarray(8, 12).equals(WEBP_SIGNATURE)
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let offset = 12;
  let canvas: ImageDimensions | null = null;
  let image: ImageDimensions | null = null;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const unpaddedEnd = dataOffset + chunkLength;
    const chunkEnd = unpaddedEnd + (chunkLength % 2);
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length
      || (chunkLength % 2 === 1 && bytes[unpaddedEnd] !== 0)) return null;
    if (offset === 12 && chunkType !== "VP8X" && chunkType !== "VP8L" && chunkType !== "VP8 ") return null;

    let current: ImageDimensions | null = null;
    if (chunkType === "VP8X") {
      if (offset !== 12 || canvas || chunkLength !== 10) return null;
      const flags = bytes[dataOffset]!;
      if ((flags & 0xc3) !== 0 || bytes[dataOffset + 1] !== 0
        || bytes[dataOffset + 2] !== 0 || bytes[dataOffset + 3] !== 0) return null;
      canvas = dimensions(1 + bytes.readUIntLE(dataOffset + 4, 3), 1 + bytes.readUIntLE(dataOffset + 7, 3));
      if (!canvas) return null;
    } else if (chunkType === "VP8L") {
      if (image || chunkLength < 5 || bytes[dataOffset] !== 0x2f) return null;
      const packed = bytes.readUInt32LE(dataOffset + 1);
      current = dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
    } else if (chunkType === "VP8 ") {
      if (image || chunkLength < 10 || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) return null;
      current = dimensions(bytes.readUInt16LE(dataOffset + 6) & 0x3fff, bytes.readUInt16LE(dataOffset + 8) & 0x3fff);
    } else if (chunkType === "ANIM" || chunkType === "ANMF") {
      // Animated images need frame-by-frame pixel accounting, so reject them here.
      return null;
    }
    if ((chunkType === "VP8L" || chunkType === "VP8 ") && !current) return null;
    if (current) image = current;
    offset = chunkEnd;
  }
  if (!image || offset !== bytes.length) return null;
  if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) return null;
  return canvas ?? image;
}

function matchingImageDimensions(mimeType: AllowedImageMimeType, bytes: Buffer): ImageDimensions | null {
  switch (mimeType) {
    case "image/jpeg": return jpegDimensions(bytes);
    case "image/png": return pngDimensions(bytes);
    case "image/webp": return webpDimensions(bytes);
  }
}

function imageId(mimeType: AllowedImageMimeType, bytes: Buffer): string {
  const digest = createHash("sha256").update(mimeType).update(bytes).digest("hex");
  return `image_${digest}`;
}

function validateAttachments(attachments: unknown): ValidatedImageAttachment[] {
  if (!Array.isArray(attachments)) return fail("Image attachments must be an array.");
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) return fail("Too many image attachments.");

  const validated: ValidatedImageAttachment[] = [];
  let totalBase64Chars = 0;
  let totalPixels = 0;

  for (let index = 0; index < attachments.length; index += 1) {
    const fields = readAttachmentFields(attachments[index]);
    if (!fields) return fail("Invalid image attachment.");
    const { type, mimeType, data } = fields;
    if (type !== "image" || !isAllowedMimeType(mimeType) || typeof data !== "string") {
      return fail("Invalid image attachment.");
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) return fail("Image attachment is too large.");

    totalBase64Chars += data.length;
    if (totalBase64Chars > MAX_IMAGE_REQUEST_BASE64_CHARS) {
      return fail("Image attachments are too large.");
    }

    const bytes = decodeCanonicalBase64(data);
    const imageDimensions = matchingImageDimensions(mimeType, bytes);
    if (!imageDimensions) return fail("Image attachment content does not match its MIME type.");
    totalPixels += imageDimensions.pixels;
    if (totalPixels > MAX_IMAGE_REQUEST_PIXELS) return fail("Image attachments contain too many pixels.");

    validated.push({ type, mimeType, data, bytes, id: imageId(mimeType, bytes) });
  }

  return validated;
}

export function validateImageAttachments(attachments: unknown): ValidatedImageAttachment[] {
  try {
    return validateAttachments(attachments);
  } catch (error) {
    if (error instanceof ImageAttachmentValidationError) throw error;
    return fail("Invalid image attachment.");
  }
}
