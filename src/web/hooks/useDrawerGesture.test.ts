import { describe, expect, it } from "vitest";
import {
  DRAWER_DEAD_ZONE,
  horizontalScrollerConsumes,
  settleDrawer,
  shouldIgnoreDrawerGesture,
} from "./useDrawerGesture";

describe("drawer gesture arbitration", () => {
  it("uses progress and velocity to settle in either direction", () => {
    expect(DRAWER_DEAD_ZONE).toBe(12);
    expect(settleDrawer(0, 0.36, 0)).toBe(true);
    expect(settleDrawer(0, 0.1, 0.5)).toBe(true);
    expect(settleDrawer(0, 0.2, 0.1)).toBe(false);
    expect(settleDrawer(1, 0.7, 0)).toBe(true);
    expect(settleDrawer(1, 0.8, -0.5)).toBe(false);
    expect(settleDrawer(1, 0.5, 0)).toBe(false);
  });

  it("ignores interactive controls and composer descendants", () => {
    const region = document.createElement("div");
    const button = document.createElement("button");
    const composer = document.createElement("div");
    composer.dataset.gestureExclusion = "";
    const text = document.createElement("span");
    composer.append(text);
    region.append(button, composer);
    document.body.append(region);
    expect(shouldIgnoreDrawerGesture(button)).toBe(true);
    expect(shouldIgnoreDrawerGesture(text)).toBe(true);
    expect(shouldIgnoreDrawerGesture(region)).toBe(false);
    region.remove();
  });

  it("defers to horizontal scrollers that can consume the drag", () => {
    const boundary = document.createElement("main");
    const scroller = document.createElement("div");
    const target = document.createElement("span");
    scroller.append(target);
    boundary.append(scroller);
    Object.defineProperties(scroller, {
      clientWidth: { value: 100 },
      scrollWidth: { value: 300 },
      scrollLeft: { value: 50, writable: true },
    });
    expect(horizontalScrollerConsumes(target, boundary, 30)).toBe(true);
    expect(horizontalScrollerConsumes(target, boundary, -30)).toBe(true);
    scroller.scrollLeft = 0;
    expect(horizontalScrollerConsumes(target, boundary, 30)).toBe(false);
    scroller.scrollLeft = 200;
    expect(horizontalScrollerConsumes(target, boundary, -30)).toBe(false);
  });
});
