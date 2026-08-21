import {
  MAX_IMAGE_ATTACHMENTS as SHARED_MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARS as SHARED_MAX_IMAGE_BASE64_CHARS,
  type ImageAttachmentInput,
  type ImageMimeType,
} from "../protocol";

export const MAX_IMAGE_ATTACHMENTS = SHARED_MAX_IMAGE_ATTACHMENTS;
export const MAX_IMAGE_DIMENSION = 2000;
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = SHARED_MAX_IMAGE_BASE64_CHARS;

export type PreparedImage = ImageAttachmentInput & {
  previewUrl: string;
  previewBlob: Blob;
};

type LoadedImage = {
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  cleanup: () => void;
};

const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const JPEG_QUALITIES = [0.9, 0.75, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08] as const;
const RESIZE_PASSES = [1, 0.75, 0.55, 0.4] as const;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.onabort = () => reject(new Error("Reading the image file was cancelled."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the image file."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

function getBase64(dataUrl: string): string {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !dataUrl.slice(0, separator).toLowerCase().endsWith(";base64")) {
    throw new Error("The browser returned invalid image data.");
  }
  return dataUrl.slice(separator + 1);
}

function createPreview(blob: Blob): { previewUrl: string; previewBlob: Blob } {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("This browser cannot create safe image previews.");
  }
  // A plain Blob does not carry the original File name.
  const previewBlob = blob.slice(0, blob.size, blob.type);
  try {
    return { previewUrl: URL.createObjectURL(previewBlob), previewBlob };
  } catch {
    throw new Error("This browser cannot create safe image previews.");
  }
}

async function loadWithImageElement(file: File): Promise<LoadedImage> {
  if (typeof Image !== "function") {
    throw new Error("This browser cannot decode images.");
  }

  let objectUrl: string | undefined;
  let sourceUrl: string;
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      objectUrl = URL.createObjectURL(file.slice(0, file.size, file.type));
      sourceUrl = objectUrl;
    } catch {
      sourceUrl = await readAsDataUrl(file);
    }
  } else {
    sourceUrl = await readAsDataUrl(file);
  }

  const image = new Image();
  return new Promise((resolve, reject) => {
    const revoke = () => {
      if (objectUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };

    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        revoke();
        reject(new Error("The image has invalid dimensions."));
        return;
      }
      resolve({ source: image, width, height, cleanup: revoke });
    };
    image.onerror = () => {
      revoke();
      reject(new Error("Could not decode the image file."));
    };
    image.src = sourceUrl;
  });
}

async function loadImage(file: File): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch {
      // Some browsers expose createImageBitmap but cannot use it for every image.
    }
  }
  return loadWithImageElement(file);
}

function drawImage(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  flattenTransparency: boolean,
): void {
  canvas.width = width;
  canvas.height = height;
  if (flattenTransparency) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not encode the image."));
    }, "image/jpeg", quality);
  });
}

async function encodeToFit(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  loaded: LoadedImage,
  initialWidth: number,
  initialHeight: number,
  flattenTransparency: boolean,
): Promise<{ data: string; blob: Blob }> {
  for (const resize of RESIZE_PASSES) {
    const width = Math.max(1, Math.round(initialWidth * resize));
    const height = Math.max(1, Math.round(initialHeight * resize));
    drawImage(canvas, context, loaded.source, width, height, flattenTransparency);

    for (const quality of JPEG_QUALITIES) {
      const blob = await canvasToBlob(canvas, quality);
      if (Math.ceil(blob.size / 3) * 4 > MAX_IMAGE_BASE64_CHARS) continue;
      const data = getBase64(await readAsDataUrl(blob));
      if (data.length <= MAX_IMAGE_BASE64_CHARS) return { data, blob };
    }
  }

  throw new Error("The image could not be compressed below the attachment size limit.");
}

export async function prepareImageFile(file: File): Promise<PreparedImage> {
  const mimeType = file.type.toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error("Unsupported image type. Choose a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("The source image is too large. Choose an image smaller than 25 MB.");
  }

  const loaded = await loadImage(file);
  try {
    const needsResize = loaded.width > MAX_IMAGE_DIMENSION || loaded.height > MAX_IMAGE_DIMENSION;
    const estimatedBase64Length = Math.ceil(file.size / 3) * 4;

    if (mimeType === "image/jpeg" && !needsResize && estimatedBase64Length <= MAX_IMAGE_BASE64_CHARS) {
      const originalDataUrl = await readAsDataUrl(file);
      const originalData = getBase64(originalDataUrl);
      if (originalData.length <= MAX_IMAGE_BASE64_CHARS) {
        return {
          type: "image",
          mimeType: mimeType as ImageMimeType,
          data: originalData,
          ...createPreview(file),
        };
      }
    }

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / loaded.width, MAX_IMAGE_DIMENSION / loaded.height);
    const width = Math.max(1, Math.round(loaded.width * scale));
    const height = Math.max(1, Math.round(loaded.height * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser cannot prepare image attachments.");
    }

    const encoded = await encodeToFit(canvas, context, loaded, width, height, mimeType !== "image/jpeg");
    return {
      type: "image",
      mimeType: "image/jpeg",
      data: encoded.data,
      ...createPreview(encoded.blob),
    };
  } finally {
    loaded.cleanup();
  }
}
