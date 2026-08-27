/**
 * A numbers panel for the one question .ui-harness cannot answer: where does
 * iOS actually put the composer when it lifts it over the keyboard.
 *
 * Off unless the URL carries `?vptrace=1`, so it is never in anyone's way. It
 * exists because the alternative is guessing, and guessing about this cost six
 * rounds on a real phone once already.
 *
 * Two things it is built to tell apart, which look identical on screen:
 *
 *   shellH much less than docH   the shell was published a keyboard-shrunk
 *                                height and is short; the composer sits at the
 *                                bottom of a box that ends above the keyboard.
 *   shellT very negative         the shell is full height and iOS simply
 *                                scrolled the page further than the composer
 *                                needed.
 *
 * `gap` is the answer either way: the distance from the bottom of the composer
 * to the bottom of the visible viewport. Zero is the composer hugging the
 * keyboard. Anything else is the bug, and its size is the measurement.
 *
 * Sampled on a timer, never on requestAnimationFrame. iOS starves rAF for
 * ~85ms across a keyboard transition, and a previous version of this panel
 * reported "nothing moved" when the truth was "we never looked".
 */

const SAMPLE_MS = 8;
const PARAMETER = "vptrace";

function readProperty(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || "—";
}

function round(value: number): number {
  return Math.round(value);
}

export function installViewportTrace(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  let enabled = false;
  try {
    enabled = new URLSearchParams(window.location.search).get(PARAMETER) === "1";
  } catch {
    return () => undefined;
  }
  if (!enabled) return () => undefined;

  const panel = document.createElement("pre");
  panel.setAttribute("aria-hidden", "true");
  panel.style.cssText = [
    "position:fixed", "z-index:2147483647", "top:0", "left:0", "right:0",
    "margin:0", "padding:4px 6px", "pointer-events:none",
    "font:600 9px/1.25 ui-monospace,Menlo,monospace",
    "color:#0f0", "background:rgba(0,0,0,.82)", "white-space:pre",
  ].join(";");
  document.body.appendChild(panel);

  /* The largest gap seen since the last time the viewport was whole. A keyboard
     transition is over in a few hundred milliseconds and the interesting frame
     is not the one anybody manages to screenshot. */
  let worstGap = 0;

  const sample = () => {
    const viewport = window.visualViewport;
    if (!viewport) {
      // Said out loud rather than left blank: a panel showing nothing looks
      // like a panel that measured nothing, which is the wrong conclusion.
      panel.textContent = "no visualViewport — nothing to trace here";
      return;
    }
    const shell = document.querySelector(".app-shell")?.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    const docHeight = document.documentElement.clientHeight;
    const keyboard = round(docHeight - viewport.height);
    // Composer bottom is in layout-viewport coordinates and the visible window
    // starts at offsetTop, so the offset has to come out of the comparison.
    const gap = composer ? round(viewport.height - (composer.bottom - viewport.offsetTop)) : 0;
    if (keyboard <= 0) worstGap = 0;
    else worstGap = Math.max(worstGap, gap);

    const active = document.activeElement;
    panel.textContent = [
      `sY ${round(window.scrollY)}  vvT ${round(viewport.offsetTop)}  vvH ${round(viewport.height)}  docH ${docHeight}  kbd ${keyboard}`,
      `shellT ${shell ? round(shell.top) : "—"}  shellH ${shell ? round(shell.height) : "—"}  compB ${composer ? round(composer.bottom) : "—"}`,
      `GAP ${gap}  worst ${worstGap}   focus ${active ? active.tagName.toLowerCase() : "none"}`,
      `--vh ${readProperty("--viewport-height")}  --vt ${readProperty("--viewport-top")}  --kh ${readProperty("--keyboard-height")}`,
    ].join("\n");
  };

  const timer = window.setInterval(sample, SAMPLE_MS);
  sample();
  return () => {
    window.clearInterval(timer);
    panel.remove();
  };
}
