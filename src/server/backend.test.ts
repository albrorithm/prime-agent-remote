import { describe, expect, it } from "vitest";
import { CoalescedRefreshQueue, uniqueSessionName, withSerialLock } from "./backend.js";

describe("uniqueSessionName", () => {
  it("keeps a name nobody else has", () => {
    expect(uniqueSessionName("Fresh", ["Other"])).toBe("Fresh");
  });

  it("suffixes duplicates case-insensitively", () => {
    expect(uniqueSessionName("fresh", ["FRESH"])).toBe("fresh 2");
    expect(uniqueSessionName("fresh", ["Fresh", "fresh 2", "FRESH 3"])).toBe("fresh 4");
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(uniqueSessionName("demo", [" demo "])).toBe("demo 2");
  });
});

describe("CoalescedRefreshQueue", () => {
  it("serializes coalesced passes and settles every covering waiter", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const queue = new CoalescedRefreshQueue({
      maxBatch: 4,
      delayMs: 0,
      run: async () => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      },
    });
    await Promise.all([queue.request(), queue.request()]);
    expect(maxActive).toBe(1);
    expect(runs).toBe(2);
    await queue.close();
  });

  it("rejects waiters for a failed pass without abandoning later requests", async () => {
    let fail = true;
    const queue = new CoalescedRefreshQueue({
      maxBatch: 4,
      delayMs: 0,
      run: async () => {
        await Promise.resolve();
        if (fail) throw new Error("refresh failed");
      },
    });
    await expect(queue.request()).rejects.toThrow("refresh failed");
    fail = false;
    await expect(queue.request()).resolves.toBeUndefined();
    await queue.close();
  });

  it("re-marks failed work dirty and retries with backoff until it recovers", async () => {
    let calls = 0;
    let recovered = 0;
    const failures: number[] = [];
    const queue = new CoalescedRefreshQueue({
      maxBatch: 4,
      delayMs: 0,
      retryDelaysMs: [5, 10],
      run: async () => {
        calls += 1;
        await Promise.resolve();
        if (calls < 3) throw new Error("refresh failed");
      },
      onFailure: (_error, consecutive) => failures.push(consecutive),
      onRecovered: () => { recovered += 1; },
    });
    await expect(queue.request()).rejects.toThrow("refresh failed");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(3);
    expect(failures).toEqual([1, 2]);
    expect(recovered).toBe(1);
    await queue.close();
  });
});

describe("withSerialLock", () => {
  it("serializes operations per key and stays usable after a failure", async () => {
    const locks = new Map<string, Promise<void>>();
    const order: string[] = [];
    const first = withSerialLock(locks, "agent", async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first:end");
      throw new Error("first failed");
    });
    const second = withSerialLock(locks, "agent", async () => {
      order.push("second");
    });
    await expect(first).rejects.toThrow("first failed");
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(locks.size).toBe(0);
  });
});
