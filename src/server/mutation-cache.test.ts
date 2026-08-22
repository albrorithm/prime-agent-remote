import { describe, expect, it, vi } from "vitest";
import { MutationCache, MutationCacheMismatchError } from "./mutation-cache.js";

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
});
