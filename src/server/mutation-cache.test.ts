import { describe, expect, it, vi } from "vitest";
import { MutationCache, MutationCacheCapacityError, MutationCacheMismatchError } from "./mutation-cache.js";

describe("MutationCache", () => {
  it("coalesces concurrent retries and caches the accepted result", async () => {
    let complete!: (value: number) => void;
    const pending = new Promise<number>((resolve) => { complete = resolve; });
    const operation = vi.fn(() => pending);
    const cache = new MutationCache<number>(1_000);

    const first = cache.run("session", "request", "binding-a", operation);
    const second = cache.run("session", "request", "binding-a", operation);
    expect(first).toBe(second);
    expect(operation).toHaveBeenCalledTimes(0);

    complete(7);
    await expect(first).resolves.toBe(7);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(cache.run("session", "request", "binding-a", operation)).resolves.toBe(7);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("allows a failed operation to be retried", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(9);
    const cache = new MutationCache<number>(1_000);

    await expect(cache.run("session", "request", "binding-a", operation)).rejects.toThrow("temporary");
    await expect(cache.run("session", "request", "binding-a", operation)).resolves.toBe(9);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("expires completed entries", async () => {
    let now = 10;
    const operation = vi.fn().mockResolvedValue(1);
    const cache = new MutationCache<number>(50, () => now);
    await cache.run("session", "request", "binding-a", operation);
    now = 61;
    await cache.run("session", "request", "binding-a", operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("rejects request ID reuse for a different mutation binding", async () => {
    const operation = vi.fn().mockResolvedValue(1);
    const cache = new MutationCache<number>(1_000);
    await cache.run("session", "request", "command:agent-a:body-a", operation);
    await expect(cache.run("session", "request", "command:agent-b:body-a", operation))
      .rejects.toBeInstanceOf(MutationCacheMismatchError);
    await expect(cache.run("session", "request", "command:agent-a:body-b", operation))
      .rejects.toBeInstanceOf(MutationCacheMismatchError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("caps entries and evicts completed results before rejecting live work", async () => {
    let finish!: (value: number) => void;
    const pending = new Promise<number>((resolve) => { finish = resolve; });
    const cache = new MutationCache<number>(1_000, Date.now, 1, 10_000);

    const first = cache.run("session", "one", "binding", () => pending);
    await expect(cache.run("session", "two", "binding", async () => 2))
      .rejects.toBeInstanceOf(MutationCacheCapacityError);
    finish(1);
    await expect(first).resolves.toBe(1);
    await expect(cache.run("session", "two", "binding", async () => 2)).resolves.toBe(2);
  });

  // The bug this guards against: a retry of the same sessionId:requestId
  // arriving after the settled TTL while the original operation is still
  // running must not cause a second execution.
  it("returns the same promise and does not re-run a still-pending operation after the settled TTL elapses", async () => {
    let now = 0;
    const never = new Promise<number>(() => {});
    const operation = vi.fn(() => never);
    const cache = new MutationCache<number>(50, () => now, 1_000);

    const first = cache.run("session", "request", "binding-a", operation);
    await Promise.resolve();
    now = 51; // past the settled TTL; the operation has still not settled
    const second = cache.run("session", "request", "binding-a", operation);
    await Promise.resolve();

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("still rejects for capacity when every cached entry is unsettled and past the settled TTL", async () => {
    let now = 0;
    const never = new Promise<number>(() => {});
    const cache = new MutationCache<number>(50, () => now, 1);

    void cache.run("session", "stuck", "binding", () => never);
    now = 51; // past the settled TTL, but the entry is unsettled and must survive prune()

    await expect(cache.run("session", "replacement", "binding", async () => 3))
      .rejects.toBeInstanceOf(MutationCacheCapacityError);
  });

  it("reaps an entry whose operation never settles once the unsettled ceiling passes", async () => {
    let now = 0;
    const never = new Promise<number>(() => {});
    const cache = new MutationCache<number>(1_000, () => now, 1, 30 * 60_000);

    void cache.run("session", "stuck", "binding", () => never);

    now = 30 * 60_000 - 1;
    await expect(cache.run("session", "replacement", "binding", async () => 3))
      .rejects.toBeInstanceOf(MutationCacheCapacityError);

    now = 30 * 60_000;
    await expect(cache.run("session", "replacement", "binding", async () => 3)).resolves.toBe(3);
  });

});
