export interface RateLimitDenied {
  allowed: false;
  retryAfterMs: number;
}

export type RateLimitDecision = { allowed: true } | RateLimitDenied;

/**
 * Sliding-window counter keyed by caller identity, bounded in both directions:
 * per-key events age out of the window, and the key map refuses new keys at
 * capacity so rotating identities cannot grow memory without bound.
 */
export class SlidingWindowLimiter {
  private readonly events = new Map<string, number[]>();
  private lastFullPruneAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly windowMs: number,
    readonly maxPerKey: number,
    readonly maxTrackedKeys: number,
  ) {}

  get trackedKeys(): number {
    return this.events.size;
  }

  /** Records the event when allowed; a denied call leaves no trace. */
  allow(key: string, now = Date.now()): RateLimitDecision {
    this.prune(now, this.events.size >= this.maxTrackedKeys);
    const recent = (this.events.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.maxPerKey) {
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + this.windowMs - now) };
    }
    if (!this.events.has(key) && this.events.size >= this.maxTrackedKeys) {
      return { allowed: false, retryAfterMs: this.windowMs };
    }
    recent.push(now);
    this.events.set(key, recent);
    return { allowed: true };
  }

  private prune(now: number, force: boolean): void {
    // Full sweeps are throttled to one per window; capacity pressure overrides
    // the throttle so a full map is cleared before refusing a new key.
    if (!force && now - this.lastFullPruneAt < this.windowMs) return;
    this.lastFullPruneAt = now;
    for (const [key, times] of this.events) {
      const recent = times.filter((time) => now - time < this.windowMs);
      if (recent.length === 0) this.events.delete(key);
      else if (recent.length !== times.length) this.events.set(key, recent);
    }
  }
}
