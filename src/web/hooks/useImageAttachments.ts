import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from "react";
import { MAX_IMAGE_ATTACHMENTS, prepareImageFile, type PreparedImage } from "../image-attachments";

const SUCCESS_PREVIEW_REVOKE_DELAY_MS = 2_000;

function isObjectPreviewUrl(url: string): boolean {
  return url.startsWith("blob:");
}

function revokePreviewUrl(url: string): void {
  if (!isObjectPreviewUrl(url) || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

const SAFE_PREPARATION_ERROR_PREFIXES = [
  "Unsupported image type.",
  "The source image is too large.",
  "Could not read the image file.",
  "Reading the image file was cancelled.",
  "The browser returned invalid image data.",
  "This browser cannot",
  "The image has invalid dimensions.",
  "The image dimensions are too large",
  "Could not decode the image file.",
  "The image could not be compressed",
] as const;

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && SAFE_PREPARATION_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))) {
    return error.message.slice(0, 240);
  }
  return "Could not prepare one of the selected images.";
}

export interface ImageAttachments {
  images: PreparedImage[];
  preparing: boolean;
  attachmentStatus: string;
  setAttachmentStatus: (status: string) => void;
  imageInputRef: RefObject<HTMLInputElement | null>;
  /** Current attachments, and which agent id they belong to. Read directly during render/submit, mirroring the original component. */
  imagesRef: RefObject<PreparedImage[]>;
  imageOwnerRef: RefObject<string>;
  /** Exposed so `submit()` can synchronously refuse to run while a preparation is in flight, without a stale-closure read of React state. */
  preparingRef: RefObject<boolean>;
  prepareSelectedFiles: (files: File[], ignoredUnsupportedFiles?: boolean) => Promise<void>;
  chooseImages: () => void;
  onImageSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  removeImage: (index: number) => void;
  /** Clears attachments after a successful submit, delaying preview revocation so the just-sent message can still render them. */
  finishSuccessfulSubmit: (sentImages: PreparedImage[]) => void;
}

// `submittingRef` is owned by Composer's submission logic, not this hook: attachment
// preparation and message submission mutually exclude each other, so each side needs
// to read the other's in-progress flag synchronously from a ref, not React state.
export function useImageAttachments(
  id: string,
  canAttachImages: boolean,
  submittingRef: RefObject<boolean>,
  closeOptions: (restoreFocus: boolean) => void,
): ImageAttachments {
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PreparedImage[]>([]);
  const imageOwnerRef = useRef("");
  const inProgressImagesRef = useRef<PreparedImage[]>([]);
  const preparingRef = useRef(false);
  const preparationVersionRef = useRef(0);
  const preparationAbortRef = useRef<AbortController | null>(null);
  const delayedRevocationsRef = useRef(new Map<string, number>());
  const activeAgentIdRef = useRef(id);
  activeAgentIdRef.current = id;

  function revokeImages(items: PreparedImage[]) {
    for (const image of items) revokePreviewUrl(image.previewUrl);
  }

  function flushDelayedRevocations() {
    for (const [url, timer] of delayedRevocationsRef.current) {
      window.clearTimeout(timer);
      revokePreviewUrl(url);
    }
    delayedRevocationsRef.current.clear();
  }

  function delaySuccessfulRevocation(items: PreparedImage[]) {
    for (const image of items) {
      const url = image.previewUrl;
      if (!isObjectPreviewUrl(url)) continue;
      const existingTimer = delayedRevocationsRef.current.get(url);
      if (existingTimer != null) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        delayedRevocationsRef.current.delete(url);
        revokePreviewUrl(url);
      }, SUCCESS_PREVIEW_REVOKE_DELAY_MS);
      delayedRevocationsRef.current.set(url, timer);
    }
  }

  function clearImages(revoke = true) {
    const current = imagesRef.current;
    imagesRef.current = [];
    imageOwnerRef.current = "";
    setImages([]);
    if (revoke) revokeImages(current);
  }

  useEffect(() => {
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    preparationVersionRef.current += 1;
    preparingRef.current = false;
    setPreparing(false);
    setAttachmentStatus("");
    if (imageInputRef.current) imageInputRef.current.value = "";
    clearImages();
    flushDelayedRevocations();

    return () => {
      preparationAbortRef.current?.abort();
      preparationAbortRef.current = null;
      preparationVersionRef.current += 1;
      preparingRef.current = false;
      revokeImages(imagesRef.current);
      imagesRef.current = [];
      revokeImages(inProgressImagesRef.current);
      inProgressImagesRef.current.length = 0;
      inProgressImagesRef.current = [];
      flushDelayedRevocations();
    };
  }, [id]);

  useEffect(() => {
    if (canAttachImages) return;
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    preparationVersionRef.current += 1;
    preparingRef.current = false;
    setPreparing(false);
    setAttachmentStatus("");
    if (imageInputRef.current) imageInputRef.current.value = "";
    clearImages();
    revokeImages(inProgressImagesRef.current);
    inProgressImagesRef.current.length = 0;
    inProgressImagesRef.current = [];
  }, [id, canAttachImages]);

  async function prepareSelectedFiles(files: File[], ignoredUnsupportedFiles = false) {
    if (!files.length || !canAttachImages) return;
    if (preparingRef.current || submittingRef.current) {
      setAttachmentStatus("Wait for the current images or message to finish.");
      return;
    }

    const available = MAX_IMAGE_ATTACHMENTS - imagesRef.current.length;
    if (available <= 0) {
      setAttachmentStatus(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      return;
    }

    const selected = files.slice(0, available);
    const reachedLimit = files.length > available;
    const version = ++preparationVersionRef.current;
    const controller = new AbortController();
    preparationAbortRef.current = controller;
    const agentId = id;
    const prepared: PreparedImage[] = [];
    const errors: string[] = [];
    inProgressImagesRef.current = prepared;
    preparingRef.current = true;
    setPreparing(true);
    setAttachmentStatus("Preparing images…");

    try {
      for (const file of selected) {
        if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) break;
        try {
          const image = await prepareImageFile(file, controller.signal);
          if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) {
            revokePreviewUrl(image.previewUrl);
            break;
          }
          prepared.push(image);
        } catch (error) {
          if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) break;
          errors.push(preparationErrorMessage(error));
        }
      }

      if (version !== preparationVersionRef.current || activeAgentIdRef.current !== agentId) {
        revokeImages(prepared);
        prepared.length = 0;
        return;
      }

      if (prepared.length) {
        const next = [...imagesRef.current, ...prepared];
        imagesRef.current = next;
        imageOwnerRef.current = agentId;
        setImages(next);
      }
      inProgressImagesRef.current = [];

      if (errors.length) {
        setAttachmentStatus(errors.length === 1
          ? errors[0]
          : `${errors.length} images could not be prepared. ${errors.at(-1)}`);
      } else if (reachedLimit) {
        setAttachmentStatus(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      } else if (ignoredUnsupportedFiles) {
        setAttachmentStatus("Unsupported files were ignored. Attach JPEG, PNG, or WebP images only.");
      } else {
        setAttachmentStatus("");
      }
    } finally {
      if (preparationAbortRef.current === controller) preparationAbortRef.current = null;
      if (inProgressImagesRef.current === prepared) inProgressImagesRef.current = [];
      if (version === preparationVersionRef.current) {
        preparingRef.current = false;
        setPreparing(false);
      }
    }
  }

  function chooseImages() {
    if (!canAttachImages || preparingRef.current || submittingRef.current) return;
    closeOptions(false);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
      imageInputRef.current.click();
    }
  }

  function onImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void prepareSelectedFiles(files);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!canAttachImages) {
      setAttachmentStatus("Image attachments are not available for this agent.");
      return;
    }
    void prepareSelectedFiles(files);
  }

  function onDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
  }

  function onDrop(event: ReactDragEvent<HTMLDivElement>) {
    const isFileDrop = Array.from(event.dataTransfer.types).includes("Files")
      || event.dataTransfer.files.length > 0;
    if (!isFileDrop) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const dropped = files.filter((file) => ["image/jpeg", "image/png", "image/webp"].includes(file.type.toLowerCase()));
    if (!canAttachImages) {
      setAttachmentStatus("Image attachments are not available for this agent.");
      return;
    }
    if (!dropped.length) {
      setAttachmentStatus("Only JPEG, PNG, or WebP image files can be attached.");
      return;
    }
    void prepareSelectedFiles(dropped, dropped.length !== files.length);
  }

  function removeImage(index: number) {
    if (preparingRef.current || submittingRef.current) return;
    const current = imagesRef.current;
    const removed = current[index];
    if (!removed) return;
    const next = current.filter((_, imageIndex) => imageIndex !== index);
    imagesRef.current = next;
    setImages(next);
    revokePreviewUrl(removed.previewUrl);
    setAttachmentStatus("");
  }

  function finishSuccessfulSubmit(sentImages: PreparedImage[]) {
    imagesRef.current = [];
    imageOwnerRef.current = "";
    setImages([]);
    delaySuccessfulRevocation(sentImages);
  }

  return {
    images,
    preparing,
    attachmentStatus,
    setAttachmentStatus,
    imageInputRef,
    imagesRef,
    imageOwnerRef,
    preparingRef,
    prepareSelectedFiles,
    chooseImages,
    onImageSelection,
    onPaste,
    onDragOver,
    onDrop,
    removeImage,
    finishSuccessfulSubmit,
  };
}
