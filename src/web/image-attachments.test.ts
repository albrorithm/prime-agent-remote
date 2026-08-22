import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_DIMENSION,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_PIXELS,
  prepareImageFile,
} from "./image-attachments";

type CanvasMock = HTMLCanvasElement & {
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
};

function mockBitmap(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width, height, close } as unknown as ImageBitmap),
  );
  return close;
}

function mockCanvas(encode: (type: string, quality?: number) => Blob) {
  const drawImage = vi.fn();
  const fillRect = vi.fn();
  const context = { drawImage, fillRect, fillStyle: "" } as unknown as CanvasRenderingContext2D;
  const toBlob = vi.fn((callback: BlobCallback, type?: string, quality?: number) => callback(encode(type ?? "", quality)));
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob,
  } as unknown as CanvasMock;
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    if (tagName === "canvas") return canvas;
    return originalCreateElement(tagName, options);
  }) as typeof document.createElement);
  return { canvas, drawImage, fillRect };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepareImageFile", () => {
  it("rejects unsupported MIME types before decoding", async () => {
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    await expect(
      prepareImageFile(new File(["not an image"], "private-name.gif", { type: "image/gif" })),
    ).rejects.toThrow(/unsupported image type/i);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("rejects oversized source files before decoding", async () => {
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    const file = new File(["small"], "private-name.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: MAX_SOURCE_IMAGE_BYTES + 1 });

    await expect(prepareImageFile(file)).rejects.toThrow(/source image is too large/i);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("re-encodes an under-limit JPEG so source metadata is not transmitted", async () => {
    const close = mockBitmap(640, 480);
    const encodedBlob = new Blob(["pixels only"], { type: "image/jpeg" });
    const { canvas, drawImage, fillRect } = mockCanvas(() => encodedBlob);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const file = new File(["jpeg with private metadata"], "private-name.jpg", { type: "image/jpeg" });

    const result = await prepareImageFile(file);

    expect(result).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      data: btoa("pixels only"),
      previewUrl: "blob:preview",
    });
    expect(result.data).not.toBe(btoa("jpeg with private metadata"));
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(drawImage).toHaveBeenCalled();
    expect(fillRect).toHaveBeenCalledWith(0, 0, 640, 480);
    expect(result.previewBlob).toBeInstanceOf(Blob);
    expect(result.previewBlob.type).toBe("image/jpeg");
    expect(JSON.stringify(result)).not.toContain("private-name.jpg");
    expect(close).toHaveBeenCalledOnce();
  });

  it("resizes through canvas while preserving the aspect ratio", async () => {
    const close = mockBitmap(4000, 1000);
    const encoded = btoa("resized jpeg");
    const encodedBlob = new Blob(["resized jpeg"], { type: "image/jpeg" });
    const { canvas, drawImage, fillRect } = mockCanvas(() => encodedBlob);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:resized-preview");
    const file = new File(["png"], "private-name.png", { type: "image/png" });

    const result = await prepareImageFile(file);

    expect(canvas.width).toBe(MAX_IMAGE_DIMENSION);
    expect(canvas.height).toBe(500);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, MAX_IMAGE_DIMENSION, 500);
    expect(fillRect).toHaveBeenCalledWith(0, 0, MAX_IMAGE_DIMENSION, 500);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);
    expect(result).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      data: encoded,
      previewUrl: "blob:resized-preview",
    });
    expect(result.previewBlob).toBeInstanceOf(Blob);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails when repeated quality and dimension reductions cannot fit", async () => {
    const close = mockBitmap(3000, 3000);
    const tooLarge = new Blob(
      [new Uint8Array(Math.floor(MAX_IMAGE_BASE64_CHARS * 3 / 4) + 1)],
      { type: "image/jpeg" },
    );
    const { canvas } = mockCanvas(() => tooLarge);

    await expect(
      prepareImageFile(new File(["large"], "private-name.jpg", { type: "image/jpeg" })),
    ).rejects.toThrow(/could not be compressed/i);
    expect(canvas.toBlob).toHaveBeenCalledTimes(32);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects decoded images with unsafe pixel counts before creating a canvas", async () => {
    const width = 10_000;
    const height = Math.floor(MAX_SOURCE_IMAGE_PIXELS / width) + 1;
    const close = mockBitmap(width, height);
    const createElement = vi.spyOn(document, "createElement");
    await expect(
      prepareImageFile(new File(["compressed"], "large.jpg", { type: "image/jpeg" })),
    ).rejects.toThrow(/dimensions are too large/i);
    expect(createElement).not.toHaveBeenCalledWith("canvas");
    expect(close).toHaveBeenCalledOnce();
  });

  it("cancels decoding and closes a bitmap that resolves after cancellation", async () => {
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; })));
    const controller = new AbortController();
    const preparation = prepareImageFile(
      new File(["image"], "cancel.jpg", { type: "image/jpeg" }),
      controller.signal,
    );
    controller.abort();
    await expect(preparation).rejects.toThrow(/cancelled/i);
    resolveBitmap({ width: 10, height: 10, close } as unknown as ImageBitmap);
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });

});
