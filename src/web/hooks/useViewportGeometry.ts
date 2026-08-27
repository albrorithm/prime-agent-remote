import { useEffect } from "react";

/* The app is a shell that fills the screen: a header, a scrolling transcript
   and a composer. This hook exists for one job — LAUNCH GEOMETRY — and for one
   deliberate non-job, the keyboard. The non-job is the more important half, and
   is why this file is much smaller than it used to be.

   THE JOB. In an installed PWA the layout viewport is occasionally reported
   taller than the screen for the first frames after a launch or a resume. A
   shell at `inset: 0` then draws taller than the display, and whichever end
   falls outside — the header or the composer — is simply not on screen. So the
   shell is sized and placed against the VISUAL viewport instead:
   `--viewport-height` is what can be seen, `--viewport-top` is where the seen
   part begins. Every use site carries its own fallback, so a tree where this
   has not run keeps the layout it had.

   THE NON-JOB. When the keyboard opens, this hook does nothing at all. Not the
   height, not the offset, not the scroll position.

   iOS does not shrink the layout viewport for a keyboard — `interactive-widget`
   is Chromium-only, as are `env(keyboard-inset-*)` and the VirtualKeyboard API,
   and no shipping Safari announces any of them. What it does instead is scroll
   the page to lift the focused field clear. Every previous version of this file
   tried to hold the shell still against that scroll: re-sizing it to the
   visible rectangle, compensating `visualViewport.offsetTop`, clamping
   `scrollY` back to zero in the scroll event itself. None of it worked, and it
   could not have: the app moved where iOS put it and was then yanked back, and
   the yank is what the reader sees. Two motions where the platform made one.

   Traced on an iPhone, `window.scrollY` reached 465 for a single frame as the
   composer came up from y~812 into a 409-tall visible window, and was back to 0
   four milliseconds later because this file put it there.

   So now the page scrolls, the header scrolls away with it, and it stays gone
   until the keyboard does. That is what chatgpt.com does on the same phone,
   which is why it has no jump to fix. `.app-shell` is absolutely positioned so
   that it travels with that scroll; a fixed shell would not, and the composer
   would stay under the keyboard.

   One thing IS still published with a keyboard up: `--keyboard-height`, because
   the composer's clearance over the home indicator is about that strip being
   covered and has nothing to do with where the page is.

   A cost worth stating: .ui-harness cannot check any of this. Its scripted
   viewport changes the numbers a page reads; it cannot scroll the page the way
   iOS does. Where the composer ends up is now the platform's answer to give,
   and only a real device can ask. */

const VIEWPORT_TOP_PROPERTY = "--viewport-top";
const VIEWPORT_HEIGHT_PROPERTY = "--viewport-height";
const KEYBOARD_HEIGHT_PROPERTY = "--keyboard-height";
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/* Pinch-zoom shrinks the visual viewport exactly as a keyboard does. Tracking
   it would shrink the app under the reader's magnifier, so above this scale we
   hand the layout back to CSS and stop measuring. */
const MAX_TRACKED_SCALE = 1.01;
/* iOS reports intermediate heights throughout the keyboard animation and gets
   the launch geometry wrong for a beat, so a measurement is re-taken over the
   next few hundred milliseconds rather than trusted the first time. */
const SETTLE_DELAYS_MS = [0, 60, 180, 400, 700];
/* How long an offset has to persist before it is believed. Only ever consulted
   with no keyboard in play — measure() returns before this when one is up — so
   what it guards is a launch or a resume that came back displaced, against the
   visualViewport events for it landing a frame or more behind the compositor
   that already moved. */
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
  let publishedKeyboard: number | null = null;
  let trackingKeyboard = false;
  /* When the current non-zero offset was first seen, or null while the page is
     at rest. Age, not value, is what decides whether it gets applied. */
  let offsetPendingSince: number | null = null;

  const focusedEditable = () => documentTarget.activeElement?.matches?.(EDITABLE_SELECTOR) === true;

  const clearPublished = () => {
    publishedTop = null;
    publishedHeight = null;
    publishedKeyboard = null;
    trackingKeyboard = false;
    offsetPendingSince = null;
    documentElement.style.removeProperty(VIEWPORT_TOP_PROPERTY);
    documentElement.style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
    documentElement.style.removeProperty(KEYBOARD_HEIGHT_PROPERTY);
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
     float the composer above the keyboard on a band of empty chrome.

     What is published is the keyboard's HEIGHT, and styles.css subtracts it
     from the inset, so the inset drains as the keyboard rises instead of being
     switched off. That is the whole difference: this used to set the inset to 0
     on the first frame the keyboard measured over 80px, which cut 19px out of
     the composer in one step while it was still on its way up — a visible jolt,
     measurable in .ui-harness/scripts/keyboard-animation-probe.mjs.

     Which means entry cannot be decided by height any more. This used to need a
     height over 80px, and by the time a keyboard is 80px tall it has already
     covered the whole inset, so a gate there drains it in one step whatever the
     value published. A focused editable is the signal instead, and it is the
     better one: it is what separates a real keyboard from a launch-time
     misreport of the layout viewport — which is the only thing the height gate
     was really carrying — and unlike a height it is already true before the
     first frame of the animation.

     Focus can leave for a button with the keyboard still up, so once believed a
     keyboard is believed until the viewport is its full height again. Not until
     it is merely short: 80px of viewport is a hardware keyboard's accessory bar
     covering the home-indicator strip just as a keyboard does, and releasing
     there would put the inset back underneath it. */
  const publishKeyboardHeight = (keyboard: number) => {
    trackingKeyboard = focusedEditable() || (trackingKeyboard && keyboard > 0);
    const height = trackingKeyboard ? keyboard : 0;
    if (publishedKeyboard === height) return;
    publishedKeyboard = height;
    if (height > 0) documentElement.style.setProperty(KEYBOARD_HEIGHT_PROPERTY, `${height}px`);
    else documentElement.style.removeProperty(KEYBOARD_HEIGHT_PROPERTY);
  };

  const measure = () => {
    const geometry = readGeometry(viewport, documentElement.clientHeight);
    if (!geometry) {
      clearPublished();
      return;
    }
    publishKeyboardHeight(geometry.keyboard);

    /* WITH A KEYBOARD UP, DO NOTHING. Not the height, not the offset, not the
       scroll correction below. This is the whole strategy and it is the
       opposite of what this file used to do.

       iOS brings a focused field out from under the keyboard by scrolling the
       page, and it is entitled to: traced on an iPhone, window.scrollY hit 465
       for a single frame as the composer came up from y~812 into a 409-tall
       visible window. Every version of this hook so far tried to hold the shell
       still against that scroll — by re-sizing it, by compensating the offset,
       by clamping scrollY back to zero. What that produced was not stillness.
       It was the app moving where iOS put it and then being yanked back, and
       the yank is the jump. Two motions where the platform only made one.

       So the app scrolls with the page and the header scrolls away with it,
       which is exactly what chatgpt.com does on the same phone, and why it has
       no jump to fix. `.app-shell` is absolutely positioned, so it travels with
       that scroll rather than fighting it.

       What is still published while the keyboard is up is --keyboard-height,
       above, because the composer's home-indicator inset is about the keyboard
       covering the strip and has nothing to do with where the page is. */
    if (trackingKeyboard) return;

    publishHeight(geometry.height);

    /* Everything from here down is the launch-and-resume path only; a keyboard
       has already returned above.

       An offset is believed only once it has stopped moving. A launch or a
       resume can leave the page genuinely displaced and that is worth
       compensating, but it does not arrive in frames — anything that is still
       changing is an animation, and applying each stale value one beat late
       walks the whole shell down the screen and back. Zero is the exception and
       is applied at once: coming back to rest can never be wrong, and must
       never be late. */
    if (geometry.top === 0) {
      offsetPendingSince = null;
      publishTop(0);
    } else {
      if (offsetPendingSince === null) offsetPendingSince = now();
      /* Until it has held still for OFFSET_SETTLE_MS this is a frame of some
         transition, so whatever is already published stays. Only a page that is
         genuinely left displaced gets compensated. */
      if (now() - offsetPendingSince >= OFFSET_SETTLE_MS) publishTop(geometry.top);
      else if (publishedTop === null) publishTop(0);
    }

    /* A launch or a resume that comes back displaced. Unreachable with a
       keyboard up, by the early return above — that scroll is iOS's to make.

       This deliberately does NOT fire on a non-zero visual-viewport offset:
       that offset is the visual viewport moving inside the layout viewport,
       which scrollTo cannot undo, so calling it there only fights WebKit
       mid-animation. */
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
