export class MutationCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; promise: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  run(sessionId: string, requestId: string, operation: () => Promise<T>): Promise<T> {
    this.prune();
    const key = `${sessionId}:${requestId}`;
    const existing = this.entries.get(key);
    if (existing) return existing.promise;

    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve().then(operation),
    };
    this.entries.set(key, entry);
    void entry.promise.then(
      () => { entry.expiresAt = this.now() + this.ttlMs; },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.promise;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
