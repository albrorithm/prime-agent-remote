import {
  MAX_IMAGE_ATTACHMENTS as SHARED_MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARS as SHARED_MAX_IMAGE_BASE64_CHARS,
  type ImageAttachmentInput,
  type ImageMimeType,
} from "../protocol";

export const MAX_IMAGE_ATTACHMENTS = SHARED_MAX_IMAGE_ATTACHMENTS;
export const MAX_IMAGE_DIMENSION = 2000;
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_IMAGE_PIXELS = 32_000_000;
export const MAX_SOURCE_IMAGE_DIMENSION = 16_384;
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

function cancelledError(): Error {
  return new Error("Reading the image file was cancelled.");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function readAsDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const reader = new FileReader();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onSignalAbort);
      callback();
    };
    const onSignalAbort = () => {
      try { reader.abort(); } catch { /* The reader may already be complete. */ }
      finish(() => reject(cancelledError()));
    };
    reader.onerror = () => finish(() => reject(new Error("Could not read the image file.")));
    reader.onabort = () => finish(() => reject(cancelledError()));
    reader.onload = () => finish(() => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the image file."));
        return;
      }
      resolve(reader.result);
    });
    signal?.addEventListener("abort", onSignalAbort, { once: true });
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

async function loadWithImageElement(file: File, signal?: AbortSignal): Promise<LoadedImage> {
  throwIfAborted(signal);
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
      sourceUrl = await readAsDataUrl(file, signal);
    }
  } else {
    sourceUrl = await readAsDataUrl(file, signal);
  }

  const image = new Image();
  return new Promise((resolve, reject) => {
    let settled = false;
    const revoke = () => {
      if (objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      image.onload = null;
      image.onerror = null;
      callback();
    };
    const onAbort = () => finish(() => {
      image.src = "";
      revoke();
      reject(cancelledError());
    });

    image.onload = () => finish(() => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        revoke();
        reject(new Error("The image has invalid dimensions."));
        return;
      }
      resolve({ source: image, width, height, cleanup: revoke });
    });
    image.onerror = () => finish(() => {
      revoke();
      reject(new Error("Could not decode the image file."));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else image.src = sourceUrl;
  });
}

async function loadImage(file: File, signal?: AbortSignal): Promise<LoadedImage> {
  throwIfAborted(signal);
  if (typeof createImageBitmap === "function") {
    let bitmapPromise: Promise<ImageBitmap> | null = null;
    try {
      bitmapPromise = createImageBitmap(file);
      const bitmap = signal
        ? await new Promise<ImageBitmap>((resolve, reject) => {
            const onAbort = () => reject(cancelledError());
            signal.addEventListener("abort", onAbort, { once: true });
            bitmapPromise!.then(
              (value) => {
                signal.removeEventListener("abort", onAbort);
                if (signal.aborted) {
                  value.close();
                  reject(cancelledError());
                } else resolve(value);
              },
              (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
          })
        : await bitmapPromise;
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      // Some browsers expose createImageBitmap but cannot use it for every image.
    }
  }
  return loadWithImageElement(file, signal);
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

function canvasToBlob(canvas: HTMLCanvasElement, quality: number, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    canvas.toBlob((blob) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
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
  signal?: AbortSignal,
): Promise<{ data: string; blob: Blob }> {
  for (const resize of RESIZE_PASSES) {
    throwIfAborted(signal);
    const width = Math.max(1, Math.round(initialWidth * resize));
    const height = Math.max(1, Math.round(initialHeight * resize));
    drawImage(canvas, context, loaded.source, width, height, true);

    for (const quality of JPEG_QUALITIES) {
      const blob = await canvasToBlob(canvas, quality, signal);
      if (Math.ceil(blob.size / 3) * 4 > MAX_IMAGE_BASE64_CHARS) continue;
      const data = getBase64(await readAsDataUrl(blob, signal));
      if (data.length <= MAX_IMAGE_BASE64_CHARS) return { data, blob };
    }
  }

  throw new Error("The image could not be compressed below the attachment size limit.");
}

export async function prepareImageFile(file: File, signal?: AbortSignal): Promise<PreparedImage> {
  throwIfAborted(signal);
  const mimeType = file.type.toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error("Unsupported image type. Choose a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("The source image is too large. Choose an image smaller than 25 MB.");
  }

  const loaded = await loadImage(file, signal);
  try {
    throwIfAborted(signal);
    if (
      loaded.width > MAX_SOURCE_IMAGE_DIMENSION
      || loaded.height > MAX_SOURCE_IMAGE_DIMENSION
      || loaded.width > Math.floor(MAX_SOURCE_IMAGE_PIXELS / loaded.height)
    ) {
      throw new Error("The image dimensions are too large to prepare safely.");
    }

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / loaded.width, MAX_IMAGE_DIMENSION / loaded.height);
    const width = Math.max(1, Math.round(loaded.width * scale));
    const height = Math.max(1, Math.round(loaded.height * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser cannot prepare image attachments.");
    }

    // Re-encode every supported format, including small JPEGs. Canvas output
    // contains pixels only and does not retain EXIF or other source metadata.
    const encoded = await encodeToFit(canvas, context, loaded, width, height, signal);
    throwIfAborted(signal);
    return {
      type: "image",
      mimeType: "image/jpeg" as ImageMimeType,
      data: encoded.data,
      ...createPreview(encoded.blob),
    };
  } finally {
    loaded.cleanup();
  }
}
