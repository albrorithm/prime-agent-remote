import { useEffect } from "react";

/* The app is a fixed shell: a header, a scrolling transcript and a composer,
   pinned to the screen with nothing behind them to scroll. On iOS WebKit —
   the engine this ships against — that arrangement has two failure modes, and
   both come from the same place: `position: fixed` resolves against the LAYOUT
   viewport, while what the user can actually see is the VISUAL viewport, and
   the two are not the same rectangle.

   1. Launch. In an installed PWA the layout viewport is occasionally reported
      taller than the screen for the first frames after launch or resume. A
      shell at `inset: 0` then draws taller than the display, and whichever end
      falls outside — the header or the composer — is simply not on screen.

   2. The keyboard. iOS uses `interactive-widget: resizes-visual` (the default,
      and still the only behaviour available here: WebKit trunk parses
      `interactive-widget` and enables it on Apple platforms, but no shipping
      Safari release announces it, and `env(keyboard-inset-*)` and the
      VirtualKeyboard API are Chromium-only). So the layout viewport does NOT
      shrink when the keyboard opens; WebKit instead scrolls the whole page up
      to drag the focused field out from under it. That is what pushes the
      header off the top, and on iPad it takes the drawers with it, because the
      drawers are part of the same page.

   The fix for both is one rule: size and place the fixed layers against the
   VISUAL viewport rather than the layout viewport. `--viewport-height` is what
   can be seen, `--viewport-top` is where the seen part begins. The shell then
   ends exactly where the keyboard begins, so the composer rests on top of it
   and nothing else has to move — the header stays, the drawers stay, and only
   the transcript, which is the shell's one flexible row, gives up the height.

   Deliberately NOT gated on display-mode or width. The keyboard behaviour is
   the same on an iPad in the browser as in an installed phone PWA, and it was
   precisely the wide layout — where the drawers are grid columns rather than
   overlays — that made the page-scrolling approach look most wrong. */

const VIEWPORT_TOP_PROPERTY = "--viewport-top";
const VIEWPORT_HEIGHT_PROPERTY = "--viewport-height";
const COMPOSER_SAFE_BOTTOM_PROPERTY = "--composer-safe-bottom";
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/* Below this a "shrunken" viewport is an accessory bar, a rounding artefact or
   a mid-launch misreport, not a keyboard worth taking the composer's bottom
   inset away for. */
const KEYBOARD_HEIGHT_THRESHOLD = 80;
/* Pinch-zoom shrinks the visual viewport exactly as a keyboard does. Tracking
   it would shrink the app under the reader's magnifier, so above this scale we
   hand the layout back to CSS and stop measuring. */
const MAX_TRACKED_SCALE = 1.01;
/* iOS reports intermediate heights throughout the keyboard animation and gets
   the launch geometry wrong for a beat, so a measurement is re-taken over the
   next few hundred milliseconds rather than trusted the first time. */
const SETTLE_DELAYS_MS = [0, 60, 180, 400, 700];
/* How long an offset has to persist before it is believed.

   The height and the offset need opposite treatment, and this is why. iOS does
   not hand over the keyboard geometry in one step: it scrolls the page to lift
   the focused field clear, then relaxes that scroll back to nothing as the
   keyboard finishes arriving — and the visualViewport events reporting it land
   a frame or more behind the compositor that already moved. Following that
   offset live applies each stale value one beat late, which walks the whole
   shell DOWN the screen and back again over the course of the animation. The
   header visibly dips.

   So the offset is only believed once it has stopped moving. Anything shorter
   than a keyboard transition is a frame of an animation, not a displaced page.
   Zero is the exception and is always applied at once: coming back to rest can
   never be wrong, and must never be late. */
const OFFSET_SETTLE_MS = 350;

type ScheduledHandle = unknown;
type FramedHandle = unknown;

interface Geometry {
  top: number;
  height: number;
  keyboard: number;
}

export interface ViewportGeometryOptions {
  viewport?: VisualViewport;
  documentTarget?: Document;
  windowTarget?: Window;
  scroll?: (x: number, y: number) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ScheduledHandle;
  cancel?: (handle: ScheduledHandle) => void;
  frame?: (callback: FrameRequestCallback) => FramedHandle;
  cancelFrame?: (handle: FramedHandle) => void;
}

/** What the visual viewport currently is, or null while it must not be tracked. */
export function readGeometry(viewport: VisualViewport, layoutHeight: number): Geometry | null {
  const scale = Number.isFinite(viewport.scale) ? viewport.scale : 1;
  const height = viewport.height;
  if (!Number.isFinite(height) || height <= 0 || scale > MAX_TRACKED_SCALE) return null;
  const offsetTop = Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0;
  /* Keyboard height is measured against the layout viewport WITHOUT subtracting
     the offset, because the two ways iOS can present a keyboard — shrink the
     visual viewport in place, or scroll the page and shrink it — differ only in
     that offset. Subtracting it would report "no keyboard" for the second. */
  return {
    top: Math.max(0, Math.round(offsetTop)),
    height: Math.round(height),
    keyboard: Math.max(0, Math.round(layoutHeight - height)),
  };
}

export function installViewportGeometry(options: ViewportGeometryOptions = {}): () => void {
  const windowTarget = options.windowTarget ?? globalThis.window;
  const documentTarget = options.documentTarget ?? globalThis.document;
  const viewport = options.viewport ?? windowTarget?.visualViewport;
  const scroll = options.scroll ?? windowTarget?.scrollTo?.bind(windowTarget);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => windowTarget.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => windowTarget.clearTimeout(handle as number));
  const frame = options.frame ?? ((callback) => windowTarget.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => windowTarget.cancelAnimationFrame(handle as number));

  if (!viewport || !documentTarget || !windowTarget || typeof scroll !== "function" ||
      typeof schedule !== "function" || typeof cancel !== "function" ||
      typeof frame !== "function" || typeof cancelFrame !== "function") {
    return () => undefined;
  }

  const documentElement = documentTarget.documentElement;
  const settleTimers = new Set<ScheduledHandle>();
  let settleFrame: FramedHandle;
  let publishedTop: number | null = null;
  let publishedHeight: number | null = null;
  let keyboardOpen = false;
  /* When the current non-zero offset was first seen, or null while the page is
     at rest. Age, not value, is what decides whether it gets applied. */
  let offsetPendingSince: number | null = null;

  const clearPublished = () => {
    publishedTop = null;
    publishedHeight = null;
    keyboardOpen = false;
    offsetPendingSince = null;
    documentElement.style.removeProperty(VIEWPORT_TOP_PROPERTY);
    documentElement.style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
    documentElement.style.removeProperty(COMPOSER_SAFE_BOTTOM_PROPERTY);
  };

  /* The height is applied the moment it is read: it is what stands the composer
     on the keyboard, and a late shrink is a composer briefly hidden behind it. */
  const publishHeight = (height: number) => {
    if (publishedHeight === height) return;
    publishedHeight = height;
    documentElement.style.setProperty(VIEWPORT_HEIGHT_PROPERTY, `${height}px`);
  };

  const publishTop = (top: number) => {
    if (publishedTop === top) return;
    publishedTop = top;
    documentElement.style.setProperty(VIEWPORT_TOP_PROPERTY, `${top}px`);
  };

  /* The composer's bottom inset clears the home indicator. While the keyboard
     covers that strip there is nothing to clear, and keeping the inset would
     float the composer above the keyboard on a band of empty chrome. Requiring
     a focused editable is what separates a real keyboard from a launch-time
     misreport of the layout viewport. */
  const publishComposerInset = (keyboard: number) => {
    const focusedEditable = documentTarget.activeElement?.matches?.(EDITABLE_SELECTOR) === true;
    const tall = keyboard >= KEYBOARD_HEIGHT_THRESHOLD;
    keyboardOpen = tall && (focusedEditable || keyboardOpen);
    if (keyboardOpen) documentElement.style.setProperty(COMPOSER_SAFE_BOTTOM_PROPERTY, "0px");
    else documentElement.style.removeProperty(COMPOSER_SAFE_BOTTOM_PROPERTY);
  };

  const measure = () => {
    const geometry = readGeometry(viewport, documentElement.clientHeight);
    if (!geometry) {
      clearPublished();
      return;
    }
    publishHeight(geometry.height);
    publishComposerInset(geometry.keyboard);

    if (geometry.top === 0) {
      offsetPendingSince = null;
      publishTop(0);
    } else {
      if (offsetPendingSince === null) offsetPendingSince = now();
      /* Until it has held still for OFFSET_SETTLE_MS this is a frame of the
         keyboard transition, so whatever is already published stays. Only a
         page that is genuinely left displaced gets compensated. */
      if (now() - offsetPendingSince >= OFFSET_SETTLE_MS) publishTop(geometry.top);
      else if (publishedTop === null) publishTop(0);
    }

    /* A real document scroll — the launch and resume case. This deliberately
       does NOT fire on a non-zero visual-viewport offset: that offset is the
       visual viewport moving inside the layout viewport, which scrollTo cannot
       undo, so calling it there only fights WebKit mid-animation. */
    if (windowTarget.scrollY > 0) scroll(0, 0);
  };

  const cancelSettle = () => {
    for (const timer of settleTimers) cancel(timer);
    settleTimers.clear();
    if (settleFrame !== undefined) cancelFrame(settleFrame);
    settleFrame = undefined;
  };

  /* One measurement now, then again as the keyboard animation and the launch
     geometry settle. Re-measuring is cheap: publish() writes nothing when the
     numbers have not moved. */
  const settle = () => {
    cancelSettle();
    settleFrame = frame(() => {
      settleFrame = undefined;
      measure();
    });
    for (const delay of SETTLE_DELAYS_MS) {
      const timer = schedule(() => {
        settleTimers.delete(timer);
        measure();
      }, delay);
      settleTimers.add(timer);
    }
  };

  const visibilityChanged = () => {
    if (documentTarget.visibilityState !== "hidden") settle();
  };

  viewport.addEventListener("resize", settle);
  viewport.addEventListener("scroll", settle);
  windowTarget.addEventListener("resize", settle);
  windowTarget.addEventListener("orientationchange", settle);
  windowTarget.addEventListener("pageshow", settle);
  windowTarget.addEventListener("scroll", settle);
  documentTarget.addEventListener("focusin", settle);
  documentTarget.addEventListener("focusout", settle);
  documentTarget.addEventListener("visibilitychange", visibilityChanged);
  measure();
  settle();

  return () => {
    cancelSettle();
    clearPublished();
    viewport.removeEventListener("resize", settle);
    viewport.removeEventListener("scroll", settle);
    windowTarget.removeEventListener("resize", settle);
    windowTarget.removeEventListener("orientationchange", settle);
    windowTarget.removeEventListener("pageshow", settle);
    windowTarget.removeEventListener("scroll", settle);
    documentTarget.removeEventListener("focusin", settle);
    documentTarget.removeEventListener("focusout", settle);
    documentTarget.removeEventListener("visibilitychange", visibilityChanged);
  };
}

export function useViewportGeometry(): void {
  useEffect(() => installViewportGeometry(), []);
}
