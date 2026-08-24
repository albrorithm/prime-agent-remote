import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit.js";

describe("SlidingWindowLimiter", () => {
  it("allows up to the per-key limit inside the window and recovers after it", () => {
    const limiter = new SlidingWindowLimiter(60_000, 2, 16);
    expect(limiter.allow("a", 0)).toEqual({ allowed: true });
    expect(limiter.allow("a", 10_000)).toEqual({ allowed: true });
    expect(limiter.allow("a", 20_000)).toEqual({ allowed: false, retryAfterMs: 40_000 });
    // The denied call must not consume budget once the oldest event ages out.
    expect(limiter.allow("a", 60_000)).toEqual({ allowed: true });
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowLimiter(60_000, 1, 16);
    expect(limiter.allow("a", 0).allowed).toBe(true);
    expect(limiter.allow("b", 0).allowed).toBe(true);
    expect(limiter.allow("a", 1).allowed).toBe(false);
  });

  it("refuses new keys at capacity and frees them once their events expire", () => {
    const limiter = new SlidingWindowLimiter(60_000, 5, 3);
    for (const key of ["a", "b", "c"]) expect(limiter.allow(key, 0).allowed).toBe(true);
    expect(limiter.trackedKeys).toBe(3);

    expect(limiter.allow("d", 1)).toEqual({ allowed: false, retryAfterMs: 60_000 });
    // Existing keys keep their remaining budget while the map is full.
    expect(limiter.allow("a", 2).allowed).toBe(true);

    // Only "a" (refreshed at t=2) and the newcomer survive the sweep.
    expect(limiter.allow("d", 60_001).allowed).toBe(true);
    expect(limiter.trackedKeys).toBe(2);
  });

  it("never grows past the tracked-key cap under key rotation", () => {
    const limiter = new SlidingWindowLimiter(60_000, 5, 8);
    for (let index = 0; index < 50; index += 1) limiter.allow(`key-${index}`, index);
    expect(limiter.trackedKeys).toBe(8);
  });
});
