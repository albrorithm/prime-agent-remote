export class MutationCacheMismatchError extends Error {}
export class MutationCacheCapacityError extends Error {}

interface MutationCacheEntry<T> {
  binding: string;
  expiresAt: number;
  settled: boolean;
  promise: Promise<T>;
}

export class MutationCache<T> {
  private readonly entries = new Map<string, MutationCacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 1_000,
    private readonly pendingTtlMs = 2 * 60_000,
  ) {}

  run(sessionId: string, requestId: string, binding: string, operation: () => Promise<T>): Promise<T> {
    this.prune();
    const key = `${sessionId}:${requestId}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.binding !== binding) {
        return Promise.reject(new MutationCacheMismatchError("Request ID was already used for a different mutation"));
      }
      // Keep recently retried results longer when the cache is used as an LRU.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }

    if (!Number.isFinite(this.maxEntries) || this.maxEntries < 1) {
      return Promise.reject(new MutationCacheCapacityError("Mutation cache is unavailable"));
    }
    this.makeRoom();
    if (this.entries.size >= this.maxEntries) {
      return Promise.reject(new MutationCacheCapacityError("Too many mutations are pending"));
    }

    const entry: MutationCacheEntry<T> = {
      binding,
      expiresAt: this.now() + Math.max(1, this.pendingTtlMs),
      settled: false,
      promise: Promise.resolve().then(operation),
    };
    this.entries.set(key, entry);
    void entry.promise.then(
      () => {
        if (this.entries.get(key) !== entry) return;
        entry.settled = true;
        entry.expiresAt = this.now() + Math.max(0, this.ttlMs);
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.promise;
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      const completed = [...this.entries].find(([, entry]) => entry.settled);
      if (!completed) return;
      this.entries.delete(completed[0]);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
