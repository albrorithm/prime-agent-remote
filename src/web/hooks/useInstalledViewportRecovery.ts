import { useEffect } from "react";

const INSTALLED_DISPLAY_QUERY = "(display-mode: fullscreen), (display-mode: standalone)";
const MOBILE_DISPLAY_QUERY = "(max-width: 720px)";
const KEYBOARD_HEIGHT_THRESHOLD = 80;
const COMPOSER_SAFE_BOTTOM_PROPERTY = "--composer-safe-bottom";
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const RESTORE_DELAY_MS = 300;
const RESTORE_RETRY_MS = 120;
const RESTORE_RETRIES = 2;

type ScheduledHandle = unknown;
type FramedHandle = unknown;

interface InstalledViewportRecoveryOptions {
  media?: MediaQueryList;
  mobileMedia?: MediaQueryList;
  viewport?: VisualViewport;
  documentTarget?: Document;
  windowTarget?: Window;
  scroll?: (x: number, y: number) => void;
  schedule?: (callback: () => void, delay: number) => ScheduledHandle;
  cancel?: (handle: ScheduledHandle) => void;
  frame?: (callback: FrameRequestCallback) => FramedHandle;
  cancelFrame?: (handle: FramedHandle) => void;
}

export function installInstalledViewportRecovery(options: InstalledViewportRecoveryOptions = {}): () => void {
  const windowTarget = options.windowTarget ?? globalThis.window;
  const documentTarget = options.documentTarget ?? globalThis.document;
  const media = options.media ?? windowTarget?.matchMedia?.(INSTALLED_DISPLAY_QUERY);
  const mobileMedia = options.mobileMedia ?? windowTarget?.matchMedia?.(MOBILE_DISPLAY_QUERY);
  const viewport = options.viewport ?? windowTarget?.visualViewport;
  const scroll = options.scroll ?? windowTarget?.scrollTo?.bind(windowTarget);
  const schedule = options.schedule ?? ((callback, delay) => windowTarget.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => windowTarget.clearTimeout(handle as number));
  const frame = options.frame ?? ((callback) => windowTarget.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => windowTarget.cancelAnimationFrame(handle as number));

  if (!media?.matches || !mobileMedia || !viewport || !documentTarget || !windowTarget ||
      typeof scroll !== "function" || typeof schedule !== "function" || typeof cancel !== "function" ||
      typeof frame !== "function" || typeof cancelFrame !== "function") {
    return () => undefined;
  }

  const documentElement = documentTarget.documentElement;
  let layoutHeight = 0;
  let pending: ScheduledHandle;
  let pendingFrame: FramedHandle;
  let pendingGeometry: ScheduledHandle;
  let pendingKeyboardFrame: FramedHandle;
  let keyboardInsetSuppressed = false;

  const cancelPendingRestore = () => {
    if (pending !== undefined) cancel(pending);
    if (pendingFrame !== undefined) cancelFrame(pendingFrame);
    pending = undefined;
    pendingFrame = undefined;
  };

  const syncKeyboardInset = () => {
    const focusedEditable = documentTarget.activeElement?.matches?.(EDITABLE_SELECTOR) === true;
    const viewportScale = Number.isFinite(viewport.scale) ? viewport.scale : 1;
    const viewportContracted = layoutHeight > 0 && viewport.height < layoutHeight - KEYBOARD_HEIGHT_THRESHOLD;
    if (mobileMedia.matches && viewportScale <= 1.01 && viewportContracted &&
        (focusedEditable || keyboardInsetSuppressed)) {
      keyboardInsetSuppressed = true;
      documentElement.style.setProperty(COMPOSER_SAFE_BOTTOM_PROPERTY, "0px");
      return;
    }
    if (!viewportContracted || viewportScale > 1.01 || !mobileMedia.matches) keyboardInsetSuppressed = false;
    if (!keyboardInsetSuppressed) documentElement.style.removeProperty(COMPOSER_SAFE_BOTTOM_PROPERTY);
  };

  const refreshGeometry = () => {
    if (!mobileMedia.matches) {
      layoutHeight = 0;
      keyboardInsetSuppressed = false;
      documentElement.style.removeProperty(COMPOSER_SAFE_BOTTOM_PROPERTY);
      return;
    }
    layoutHeight = Math.max(documentElement.clientHeight, viewport.height);
    syncKeyboardInset();
  };

  const originIsZero = () => [windowTarget.scrollY, viewport.offsetTop, viewport.pageTop]
    .every((value) => !Number.isFinite(value) || Math.abs(value) < 1);

  const restore = (attempt = 0) => {
    pending = undefined;
    if (!mobileMedia.matches || viewport.height < layoutHeight - 1) return;
    pendingFrame = frame(() => {
      pendingFrame = undefined;
      if (!originIsZero()) scroll(0, 0);
      if (originIsZero()) {
        if (pending !== undefined) cancel(pending);
        pending = undefined;
      } else if (attempt < RESTORE_RETRIES) {
        if (pending !== undefined) cancel(pending);
        pending = schedule(() => restore(attempt + 1), RESTORE_RETRY_MS);
      }
    });
  };

  const scheduleRestore = () => {
    cancelPendingRestore();
    if (mobileMedia.matches) pending = schedule(restore, RESTORE_DELAY_MS);
  };

  const viewportResized = () => {
    if (pendingKeyboardFrame !== undefined) cancelFrame(pendingKeyboardFrame);
    pendingKeyboardFrame = frame(() => {
      pendingKeyboardFrame = undefined;
      syncKeyboardInset();
      if (viewport.height >= layoutHeight - KEYBOARD_HEIGHT_THRESHOLD) scheduleRestore();
    });
  };

  const geometryChanged = () => {
    if (pendingGeometry !== undefined) cancel(pendingGeometry);
    pendingGeometry = schedule(() => {
      pendingGeometry = undefined;
      refreshGeometry();
      scheduleRestore();
    }, RESTORE_DELAY_MS);
  };

  const focusChanged = () => {
    viewportResized();
    scheduleRestore();
  };

  const visibilityChanged = () => {
    if (documentTarget.visibilityState !== "hidden") geometryChanged();
  };

  viewport.addEventListener("resize", viewportResized);
  viewport.addEventListener("scroll", scheduleRestore);
  mobileMedia.addEventListener?.("change", geometryChanged);
  windowTarget.addEventListener("scroll", scheduleRestore);
  windowTarget.addEventListener("resize", geometryChanged);
  windowTarget.addEventListener("orientationchange", geometryChanged);
  windowTarget.addEventListener("pageshow", geometryChanged);
  documentTarget.addEventListener("focusin", focusChanged);
  documentTarget.addEventListener("focusout", focusChanged);
  documentTarget.addEventListener("visibilitychange", visibilityChanged);
  refreshGeometry();
  scheduleRestore();

  return () => {
    cancelPendingRestore();
    if (pendingGeometry !== undefined) cancel(pendingGeometry);
    if (pendingKeyboardFrame !== undefined) cancelFrame(pendingKeyboardFrame);
    documentElement.style.removeProperty(COMPOSER_SAFE_BOTTOM_PROPERTY);
    viewport.removeEventListener("resize", viewportResized);
    viewport.removeEventListener("scroll", scheduleRestore);
    mobileMedia.removeEventListener?.("change", geometryChanged);
    windowTarget.removeEventListener("scroll", scheduleRestore);
    windowTarget.removeEventListener("resize", geometryChanged);
    windowTarget.removeEventListener("orientationchange", geometryChanged);
    windowTarget.removeEventListener("pageshow", geometryChanged);
    documentTarget.removeEventListener("focusin", focusChanged);
    documentTarget.removeEventListener("focusout", focusChanged);
    documentTarget.removeEventListener("visibilitychange", visibilityChanged);
  };
}

export function useInstalledViewportRecovery(): void {
  useEffect(() => installInstalledViewportRecovery(), []);
}
