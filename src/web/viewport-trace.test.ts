import { afterEach, describe, expect, it } from "vitest";
import { installViewportTrace } from "./viewport-trace";

const cleanups: Array<() => void> = [];

function install(search: string): () => void {
  window.history.replaceState(null, "", search);
  const cleanup = installViewportTrace();
  cleanups.push(cleanup);
  return cleanup;
}

function panel(): HTMLElement | null {
  return document.querySelector("pre[aria-hidden='true']");
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.history.replaceState(null, "", "/");
});

describe("installViewportTrace", () => {
  // The whole bargain of shipping a diagnostic: it costs nothing to anyone who
  // did not ask for it.
  it("does nothing at all without the query parameter", () => {
    install("/");
    expect(panel()).toBeNull();
  });

  it("does nothing for a value other than 1", () => {
    install("/?vptrace=0");
    expect(panel()).toBeNull();
    install("/?vptrace=yes");
    expect(panel()).toBeNull();
  });

  it("renders a panel when asked, and takes it away again", () => {
    const cleanup = install("/?vptrace=1");
    const rendered = panel();
    expect(rendered).not.toBeNull();
    cleanup();
    expect(panel()).toBeNull();
  });

  // jsdom has no visualViewport. A panel that renders empty in that case reads
  // as "measured nothing" rather than "could not measure", which is the wrong
  // conclusion to hand someone staring at a phone.
  it("says so rather than going blank when there is no visual viewport", () => {
    install("/?vptrace=1");
    expect(panel()?.textContent).toContain("no visualViewport");
  });

  it("labels the numbers it does take", () => {
    const viewport = { height: 500, offsetTop: 300, scale: 1, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      install("/?vptrace=1");
      const text = panel()?.textContent ?? "";
      // GAP is the measurement the whole panel exists for.
      expect(text).toContain("GAP");
      expect(text).toContain("shellH");
      expect(text).toContain("kbd");
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    }
  });

  it("does not paint over the app it is measuring", () => {
    install("/?vptrace=1");
    expect(panel()?.style.pointerEvents).toBe("none");
  });
});
