import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PUSH_SUBSCRIPTIONS,
  PushSubscriptionStore,
  type StoredPushSubscription,
} from "./push-store.js";

let root: string;
let storePath: string;

function subscription(overrides: Partial<StoredPushSubscription> = {}): StoredPushSubscription {
  return {
    endpoint: "https://push.example.test/one",
    p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU",
    auth: "3v0fHqQhH3xQ1r6mB3dOsg",
    sessionId: "session-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function readStore(): Promise<{ version: number; subscriptions: unknown[] }> {
  return JSON.parse(await readFile(storePath, "utf8")) as { version: number; subscriptions: unknown[] };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "push-store-"));
  storePath = path.join(root, "nested", "push-subscriptions.json");
});

afterEach(async () => {
  await chmod(root, 0o700).catch(() => {});
  await chmod(path.dirname(storePath), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe("PushSubscriptionStore", () => {
  it("starts empty when the file does not exist yet", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  /* The upgrade path, and it is the dangerous one. Every record written before
     `turnEnd` existed lacks the field; the record schema is `.strict()`, and an
     unreadable store falls back to EMPTY rather than failing loudly. So a
     required field here would have silently unsubscribed every already-paired
     device on upgrade, with no error anywhere and no way to notice except that
     notifications quietly stopped. */
  it("reads a record written before turn-end notifications existed", async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    const legacy = {
      endpoint: "https://push.example.test/device",
      p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU",
      auth: "3v0fHqQhH3xQ1r6mB3dOsg",
      sessionId: "session-1",
      createdAt: "2026-08-27T00:00:00.000Z",
    };
    await writeFile(storePath, JSON.stringify({ version: 1, subscriptions: [legacy] }), "utf8");

    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list()).toHaveLength(1);
    // Absent means no, which is the safe reading: an existing device did not
    // ask to be told about finished turns.
    expect(store.list()[0]?.turnEnd).toBeUndefined();
  });

  it("persists a subscription and reads it back in a fresh process", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription());

    const reopened = new PushSubscriptionStore(storePath);
    await reopened.load();
    expect(reopened.list()).toEqual([subscription()]);
  });

  it("creates the store private to the owner", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription());

    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files beside the store", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription());
    await store.upsert(subscription({ endpoint: "https://push.example.test/two" }));

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.dirname(storePath))).toEqual(["push-subscriptions.json"]);
  });

  // Rebinding is what makes sign-out complete: a device whose original session
  // expired must end up owned by the session that is about to sign out.
  it("rebinds an endpoint to the newest session instead of duplicating it", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription({ sessionId: "expired-session" }));
    await store.upsert(subscription({ sessionId: "current-session" }));

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].sessionId).toBe("current-session");
  });

  it("drops every record a signed-out session owns and nobody else's", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription({ endpoint: "https://push.example.test/phone", sessionId: "session-a" }));
    await store.upsert(subscription({ endpoint: "https://push.example.test/tablet", sessionId: "session-a" }));
    await store.upsert(subscription({ endpoint: "https://push.example.test/laptop", sessionId: "session-b" }));

    expect(await store.removeSession("session-a")).toBe(2);
    expect(store.list().map((record) => record.endpoint)).toEqual(["https://push.example.test/laptop"]);
    expect((await readStore()).subscriptions).toHaveLength(1);
    expect(await store.removeSession("session-a")).toBe(0);
  });

  // The case `removeSession` cannot reach: the record's session died with an
  // earlier process, and only the device binding still names it.
  it("drops a revoked device's records however long ago its session died", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription({ endpoint: "https://push.example.test/phone", sessionId: "long-gone", deviceId: "device-a" }));
    await store.upsert(subscription({ endpoint: "https://push.example.test/laptop", sessionId: "live", deviceId: "device-b" }));

    expect(await store.removeDevice("device-a")).toBe(1);
    expect(store.list().map((record) => record.endpoint)).toEqual(["https://push.example.test/laptop"]);
    expect((await readStore()).subscriptions).toHaveLength(1);
    expect(await store.removeDevice("device-a")).toBe(0);
  });

  // Written before subscriptions carried a device id: unreachable by device,
  // which is why `removeAll` and not `removeDevice` backs `--revoke all`.
  it("leaves a record with no device id alone on removeDevice, and takes it on removeAll", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription({ endpoint: "https://push.example.test/legacy" }));
    await store.upsert(subscription({ endpoint: "https://push.example.test/phone", deviceId: "device-a" }));

    expect(await store.removeDevice("device-a")).toBe(1);
    expect(store.list().map((record) => record.endpoint)).toEqual(["https://push.example.test/legacy"]);

    expect(await store.removeAll()).toBe(1);
    expect(store.list()).toEqual([]);
    expect((await readStore()).subscriptions).toEqual([]);
  });

  // Same reason turnEnd is optional: `.strict()` plus a fall-back-to-empty
  // load means a required field silently unsubscribes everyone on upgrade.
  it("reads a record written before subscriptions carried a device id", async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    const legacy = {
      endpoint: "https://push.example.test/device",
      p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU",
      auth: "3v0fHqQhH3xQ1r6mB3dOsg",
      sessionId: "session-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      turnEnd: true,
    };
    await writeFile(storePath, JSON.stringify({ version: 1, subscriptions: [legacy] }), "utf8");

    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].deviceId).toBeUndefined();
  });

  it("tells a strict loader that an unreadable store is not an empty one", async () => {
    const absent = new PushSubscriptionStore(storePath);
    await absent.load({ strict: true });
    expect(absent.list()).toEqual([]);

    await mkdir(storePath, { recursive: true });
    const unreadable = new PushSubscriptionStore(storePath);
    await expect(unreadable.load({ strict: true })).rejects.toThrow();
    await unreadable.load();
    expect(unreadable.list()).toEqual([]);
  });

  /* After a failed write, memory has already dropped the record and disk has
     not. The next mutation is the retry, whether or not it matches anything;
     without this, a revoke retried after the disk came back found nothing to
     do and left the stale record to wake the phone until a restart. */
  it("treats a miss on a store whose last write failed as the write it still owes", async () => {
    const blocker = path.join(path.dirname(storePath), "blocker");
    const blocked = path.join(blocker, "store.json");
    await mkdir(path.dirname(blocker), { recursive: true });
    await writeFile(blocker, "a file where the directory has to go", "utf8");
    const store = new PushSubscriptionStore(blocked, []);
    await store.load();
    await expect(store.upsert(subscription({ endpoint: "https://push.example.test/phone", deviceId: "device-a" }))).rejects.toThrow();
    expect(store.hasPendingWrite).toBe(true);
    await expect(store.removeDevice("device-a")).rejects.toThrow();
    expect(store.list()).toEqual([]);

    await rm(blocker);
    expect(await store.removeDevice("device-a")).toBe(0);
    expect(store.hasPendingWrite).toBe(false);
    expect(JSON.parse(await readFile(blocked, "utf8")).subscriptions).toEqual([]);
  });

  it("never persists when nothing matched, so an unreadable store is not truncated", async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, "{ not json", "utf8");

    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list()).toEqual([]);

    expect(await store.removeDevice("device-a")).toBe(0);
    expect(await store.removeAll()).toBe(0);
    expect(await readFile(storePath, "utf8")).toBe("{ not json");
  });

  it("removes a single endpoint and reports whether it was there", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription());

    expect(await store.removeEndpoint("https://push.example.test/absent")).toBe(false);
    expect(await store.removeEndpoint("https://push.example.test/one")).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("evicts the oldest record at capacity", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    for (let index = 0; index < MAX_PUSH_SUBSCRIPTIONS + 3; index += 1) {
      await store.upsert(subscription({ endpoint: `https://push.example.test/${index}` }));
    }

    expect(store.list()).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(store.list()[0].endpoint).toBe("https://push.example.test/3");
  });

  it("falls back to empty on unparseable or wrong-shaped storage rather than throwing", async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    for (const body of ["not json at all", "[]", '{"version":99,"subscriptions":[]}', '{"subscriptions":[]}']) {
      await writeFile(storePath, body);
      const store = new PushSubscriptionStore(storePath);
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.list()).toEqual([]);
    }
  });

  it("keeps the good records in a partly corrupt file", async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify({
      version: 1,
      subscriptions: [
        subscription({ endpoint: "https://push.example.test/good" }),
        { endpoint: "not-a-url", p256dh: "k", auth: "a", sessionId: "s", createdAt: "t" },
        { endpoint: "https://push.example.test/incomplete" },
        "nonsense",
      ],
    }));

    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list().map((record) => record.endpoint)).toEqual(["https://push.example.test/good"]);
  });

  it("rejects an oversized stored record instead of holding it in memory", async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify({
      version: 1,
      subscriptions: [subscription({ endpoint: `https://push.example.test/${"x".repeat(2000)}` })],
    }));

    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it("surfaces a write failure to the caller rather than reporting a phantom subscription", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await chmod(root, 0o500);

    await expect(store.upsert(subscription())).rejects.toThrow();
  });

  // A rejected write must not poison writes queued behind it.
  it("keeps writing after a failed write recovers", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await chmod(root, 0o500);
    await store.upsert(subscription()).catch(() => {});
    await chmod(root, 0o700);

    await expect(store.upsert(subscription({ endpoint: "https://push.example.test/later" }))).resolves.toBeUndefined();
    expect((await readStore()).subscriptions).toHaveLength(2);
  });

  // A push subscription is a capability to wake a device. If a revocation's
  // write fails, the in-memory view must drop it immediately regardless —
  // the running process must never send to it again — even though the file
  // on disk is still stale until a retry succeeds.
  it("removes a record from the in-memory view even when persisting the removal fails", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    await store.upsert(subscription());
    // The store directory already exists (from the upsert above), so
    // chmod-ing root alone wouldn't block writes into it — the store's own
    // directory has to lose write permission.
    await chmod(path.dirname(storePath), 0o500);

    await expect(store.removeEndpoint(subscription().endpoint)).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("retries a failed removal in the background and eventually persists it", async () => {
    const store = new PushSubscriptionStore(storePath, [5, 5, 5]);
    await store.load();
    await store.upsert(subscription());
    await chmod(path.dirname(storePath), 0o500);

    await store.removeEndpoint(subscription().endpoint).catch(() => {});
    expect(store.list()).toEqual([]);
    expect((await readStore()).subscriptions).toHaveLength(1); // still stale on disk

    await chmod(path.dirname(storePath), 0o700);
    // Give the 5ms background retry time to fire and succeed.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await readStore()).subscriptions).toEqual([]);
  });

  it("bounds persistence retries with backoff and never holds the event loop open", async () => {
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
    vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const store = new PushSubscriptionStore(storePath, [1, 2, 3]);
      await store.load();
      await store.upsert(subscription());
      await chmod(path.dirname(storePath), 0o500);
      await store.removeEndpoint(subscription().endpoint).catch(() => {});

      // Real time for all three backoff retries to fire; the directory stays
      // unwritable throughout, so every retry fails and none writes past the
      // configured ceiling.
      await new Promise((resolve) => realSetTimeout(resolve, 150));

      expect(scheduled).toEqual([1, 2, 3]);
      expect(unrefSpies).toHaveLength(3);
      for (const unrefSpy of unrefSpies) expect(unrefSpy).toHaveBeenCalledTimes(1);
      const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
      expect(logged).toContain("may return after a restart");
    } finally {
      vi.restoreAllMocks();
      await chmod(path.dirname(storePath), 0o700);
    }
  });
});
