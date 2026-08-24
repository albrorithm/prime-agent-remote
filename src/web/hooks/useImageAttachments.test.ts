import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedImage } from "../image-attachments";

const imageAttachmentMock = vi.hoisted(() => ({ prepareImageFile: vi.fn() }));
vi.mock("../image-attachments", () => ({
  MAX_IMAGE_ATTACHMENTS: 3,
  prepareImageFile: imageAttachmentMock.prepareImageFile,
}));

const { useImageAttachments } = await import("./useImageAttachments");

let preparedCount = 0;

function nextImage(overrides: Partial<PreparedImage> = {}): PreparedImage {
  preparedCount += 1;
  return {
    type: "image",
    mimeType: "image/png",
    data: `prepared-${preparedCount}`,
    previewUrl: `blob:preview-${preparedCount}`,
    previewBlob: new Blob(),
    ...overrides,
  };
}

function file(name = "photo.png") {
  return new File(["image"], name, { type: "image/png" });
}

function setup(id = "agent-1", canAttachImages = true) {
  const closeOptions = vi.fn();
  return renderHook(
    ({ id, canAttachImages }: { id: string; canAttachImages: boolean }) => {
      const submittingRef = useRef(false);
      return { attachments: useImageAttachments(id, canAttachImages, submittingRef, closeOptions), submittingRef };
    },
    { initialProps: { id, canAttachImages } },
  );
}

beforeEach(() => {
  preparedCount = 0;
  imageAttachmentMock.prepareImageFile.mockReset();
  imageAttachmentMock.prepareImageFile.mockImplementation(async () => nextImage());
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("useImageAttachments", () => {
  it("prepares selected files and appends them to the attachment list", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file()]);
    });
    expect(result.current.attachments.images).toHaveLength(1);
    expect(result.current.attachments.imagesRef.current).toHaveLength(1);
    expect(result.current.attachments.imageOwnerRef.current).toBe("agent-1");
    expect(result.current.attachments.attachmentStatus).toBe("");
  });

  it("refuses to prepare files while a submission is in progress", async () => {
    const { result } = setup();
    result.current.submittingRef.current = true;
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file()]);
    });
    expect(imageAttachmentMock.prepareImageFile).not.toHaveBeenCalled();
    expect(result.current.attachments.attachmentStatus).toBe("Wait for the current images or message to finish.");
  });

  it("refuses to prepare files while another preparation is already running", async () => {
    let release!: () => void;
    imageAttachmentMock.prepareImageFile.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(nextImage()); }),
    );
    const { result } = setup();
    let firstDone: Promise<void>;
    act(() => {
      firstDone = result.current.attachments.prepareSelectedFiles([file("a.png")]);
    });
    expect(result.current.attachments.preparingRef.current).toBe(true);

    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file("b.png")]);
    });
    expect(imageAttachmentMock.prepareImageFile).toHaveBeenCalledTimes(1);
    expect(result.current.attachments.attachmentStatus).toBe("Wait for the current images or message to finish.");

    await act(async () => {
      release();
      await firstDone;
    });
    expect(result.current.attachments.images).toHaveLength(1);
  });

  it("discards in-flight preparation results when the agent switches mid-flight", async () => {
    let release!: (image: PreparedImage) => void;
    imageAttachmentMock.prepareImageFile.mockImplementationOnce(
      () => new Promise<PreparedImage>((resolve) => { release = resolve; }),
    );
    const { result, rerender } = setup("agent-1");

    let done!: Promise<void>;
    act(() => {
      done = result.current.attachments.prepareSelectedFiles([file()]);
    });
    rerender({ id: "agent-2", canAttachImages: true });

    await act(async () => {
      release(nextImage());
      await done;
    });

    // The completed image belonged to agent-1, which is no longer active.
    expect(result.current.attachments.imageOwnerRef.current).not.toBe("agent-1");
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("clears attachments and revokes previews when switching agents", async () => {
    const { result, rerender } = setup("agent-1");
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file()]);
    });
    expect(result.current.attachments.images).toHaveLength(1);

    rerender({ id: "agent-2", canAttachImages: true });
    expect(result.current.attachments.images).toHaveLength(0);
    expect(result.current.attachments.imageOwnerRef.current).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  });

  it("clears attachments when image capability is revoked without an agent switch", async () => {
    const { result, rerender } = setup("agent-1", true);
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file()]);
    });
    expect(result.current.attachments.images).toHaveLength(1);

    rerender({ id: "agent-1", canAttachImages: false });
    expect(result.current.attachments.images).toHaveLength(0);
  });

  it("removes an individual image and revokes only its preview", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file("a.png"), file("b.png")]);
    });
    expect(result.current.attachments.images).toHaveLength(2);

    act(() => {
      result.current.attachments.removeImage(0);
    });
    expect(result.current.attachments.images).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  });

  it("finishSuccessfulSubmit clears attachments but delays preview revocation", async () => {
    vi.useFakeTimers();
    try {
      const { result } = setup();
      await act(async () => {
        await result.current.attachments.prepareSelectedFiles([file()]);
      });
      const sent = result.current.attachments.imagesRef.current;

      act(() => {
        result.current.attachments.finishSuccessfulSubmit(sent);
      });
      expect(result.current.attachments.images).toHaveLength(0);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps attachments at MAX_IMAGE_ATTACHMENTS and reports the overflow", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file("a"), file("b"), file("c"), file("d")]);
    });
    expect(result.current.attachments.images).toHaveLength(3);
    expect(result.current.attachments.attachmentStatus).toBe("You can attach up to 3 images.");
  });

  it("reports a safe error message without leaking file names", async () => {
    imageAttachmentMock.prepareImageFile.mockRejectedValueOnce(new Error("Could not decode the image file."));
    const { result } = setup();
    await act(async () => {
      await result.current.attachments.prepareSelectedFiles([file("secret-name.png")]);
    });
    expect(result.current.attachments.attachmentStatus).toBe("Could not decode the image file.");
    expect(result.current.attachments.attachmentStatus).not.toContain("secret-name");
  });

  it("aborts an in-flight preparation on unmount", async () => {
    let signal: AbortSignal | undefined;
    imageAttachmentMock.prepareImageFile.mockImplementationOnce(
      (_file: File, abortSignal: AbortSignal) => {
        signal = abortSignal;
        return new Promise(() => {});
      },
    );
    const { result, unmount } = setup();
    act(() => {
      void result.current.attachments.prepareSelectedFiles([file()]);
    });
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
