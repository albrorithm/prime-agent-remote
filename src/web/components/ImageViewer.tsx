import { Download, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from "react";

interface ImageViewerProps {
  alt: string;
  downloadName: string;
  onClose: () => void;
  src: string;
}

export function ImageViewer({ alt, downloadName, onClose, src }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const titleId = useId();

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const rootWasInert = appRoot?.hasAttribute("inert") ?? false;
    const previousOverflow = document.body.style.overflow;
    appRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    return () => {
      if (!rootWasInert) appRoot?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const actions = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []);
    const first = actions[0];
    const last = actions.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeFromBackdrop(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    const stage = event.currentTarget.getBoundingClientRect();
    if (!image?.naturalWidth || !image.naturalHeight || !stage.width || !stage.height) {
      onClose();
      return;
    }

    const scale = Math.min(stage.width / image.naturalWidth, stage.height / image.naturalHeight);
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const x = event.clientX - stage.left;
    const y = event.clientY - stage.top;
    const outsideImage = x < (stage.width - renderedWidth) / 2
      || x > (stage.width + renderedWidth) / 2
      || y < (stage.height - renderedHeight) / 2
      || y > (stage.height + renderedHeight) / 2;
    if (outsideImage) onClose();
  }

  return createPortal(
    <div
      className="image-viewer"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
      data-gesture-exclusion
    >
      <h2 className="sr-only" id={titleId}>{alt}</h2>
      <div className="image-viewer-toolbar">
        <button className="image-viewer-action" type="button" ref={closeRef} onClick={onClose}>
          <X aria-hidden="true" />
          <span>Close</span>
        </button>
        <a className="image-viewer-action" href={src} download={downloadName}>
          <Download aria-hidden="true" />
          <span>Download</span>
        </a>
      </div>
      <div className="image-viewer-stage" onPointerDown={closeFromBackdrop}>
        <img ref={imageRef} src={src} alt={`${alt} full size`} />
      </div>
    </div>,
    document.body,
  );
}
