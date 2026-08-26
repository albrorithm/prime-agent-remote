import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  await rm(root, { recursive: true, force: true });
});

describe("PushSubscriptionStore", () => {
  it("starts empty when the file does not exist yet", async () => {
    const store = new PushSubscriptionStore(storePath);
    await store.load();
    expect(store.list()).toEqual([]);
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
});
