export class MutationCacheMismatchError extends Error {}
export class MutationCacheCapacityError extends Error {}

interface MutationCacheEntry<T> {
  binding: string;
  createdAt: number;
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
    // A retry racing a slow-but-alive operation must find the same pending
    // promise, not trigger a second execution — so prune() never drops an
    // unsettled entry on the ordinary TTL path (see prune()). This is the
    // only thing that reaps an operation that never settles at all: a hard
    // ceiling measured from creation, far longer than any real operation
    // should take.
    private readonly unsettledTtlMs = 30 * 60_000,
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
      createdAt: this.now(),
      // Meaningful once settled; an unsettled entry is reaped on
      // `unsettledTtlMs` from `createdAt` instead.
      expiresAt: Number.POSITIVE_INFINITY,
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
      // A settled entry expires on the ordinary TTL. An unsettled one never
      // does on this path — a retry for the same key must keep finding the
      // in-flight promise, or the operation runs twice. Only an operation
      // that has genuinely died is reaped, and only past unsettledTtlMs.
      if (entry.settled) {
        if (entry.expiresAt <= now) this.entries.delete(key);
      } else if (entry.createdAt + this.unsettledTtlMs <= now) {
        this.entries.delete(key);
      }
    }
  }
}
