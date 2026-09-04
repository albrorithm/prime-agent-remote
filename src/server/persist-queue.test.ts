import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistQueue } from "./persist-queue.js";

let root: string;
let filePath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "atomic-write-"));
  filePath = path.join(root, "nested", "state.json");
});

afterEach(async () => {
  await chmod(root, 0o700).catch(() => {});
  await chmod(path.dirname(filePath), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe("PersistQueue", () => {
  it("writes whatever the renderer says at the time of the call", async () => {
    let state = "a";
    const queue = new PersistQueue(filePath, () => state);
    await queue.persist();
    expect(await readFile(filePath, "utf8")).toBe("a");
    state = "b";
    await queue.persist();
    expect(await readFile(filePath, "utf8")).toBe("b");
  });

  it("serializes overlapping writes and lands the last state", async () => {
    let state = 0;
    const queue = new PersistQueue(filePath, () => String(state));
    const writes = [];
    for (; state < 5; state += 1) writes.push(queue.persist());
    await Promise.all(writes);
    expect(await readFile(filePath, "utf8")).toBe("4");
    expect(await readdir(path.dirname(filePath))).toEqual(["state.json"]);
  });

  it("rejects the failed write and keeps writing once the disk recovers", async () => {
    const queue = new PersistQueue(filePath, () => "body", { retryDelaysMs: [] });
    await queue.persist();
    await chmod(path.dirname(filePath), 0o500);
    await expect(queue.persist()).rejects.toThrow();
    await chmod(path.dirname(filePath), 0o700);
    await expect(queue.persist()).resolves.toBeUndefined();
  });

  it("does not clear a newer pending write when an older write lands", async () => {
    let state = "old";
    const queue = new PersistQueue(filePath, () => state);
    const first = queue.persist();
    state = "new";
    const second = queue.persist();
    await first;
    expect(queue.hasPendingWrite).toBe(true);
    await second;
    expect(queue.hasPendingWrite).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("new");
  });

  it("leaves persistence pending when retries are disabled", async () => {
    const exhausted = vi.fn();
    const queue = new PersistQueue(filePath, () => "current", { retryDelaysMs: [], onRetriesExhausted: exhausted });
    await queue.persist();
    await chmod(path.dirname(filePath), 0o500);
    await expect(queue.persist()).rejects.toThrow();
    expect(queue.hasPendingWrite).toBe(true);
    expect(exhausted).toHaveBeenCalledTimes(1);
    await chmod(path.dirname(filePath), 0o700);
    await queue.persist();
    expect(queue.hasPendingWrite).toBe(false);
  });

  it("retries a failed write in the background with the current state", async () => {
    let state = "stale";
    const queue = new PersistQueue(filePath, () => state, { retryDelaysMs: [5, 5, 5] });
    await queue.persist();
    await chmod(path.dirname(filePath), 0o500);
    state = "revoked";
    await queue.persist().catch(() => {});
    expect(await readFile(filePath, "utf8")).toBe("stale");

    await chmod(path.dirname(filePath), 0o700);
    // The renderer is consulted again when the retry fires, not when the
    // failed write was queued.
    state = "revoked, then more";
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(filePath, "utf8")).toBe("revoked, then more");
  });

  it("gives up after the configured retries, says so once, and does not hold the loop open", async () => {
    const realSetTimeout = global.setTimeout;
    const scheduled: number[] = [];
    const unrefSpies: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: (...fnArgs: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(fn, ms, ...args);
      if (ms === 1 || ms === 2 || ms === 3) {
        scheduled.push(ms);
        const originalUnref = handle.unref.bind(handle);
        const unrefSpy = vi.fn(() => originalUnref());
        handle.unref = unrefSpy;
        unrefSpies.push(unrefSpy);
      }
      return handle;
    }) as typeof setTimeout);
    const exhausted = vi.fn();

    try {
      const queue = new PersistQueue(filePath, () => "body", { retryDelaysMs: [1, 2, 3], onRetriesExhausted: exhausted });
      await queue.persist();
      await chmod(path.dirname(filePath), 0o500);
      await queue.persist().catch(() => {});
      await new Promise((resolve) => realSetTimeout(resolve, 150));

      expect(scheduled).toEqual([1, 2, 3]);
      for (const unrefSpy of unrefSpies) expect(unrefSpy).toHaveBeenCalledTimes(1);
      expect(exhausted).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
