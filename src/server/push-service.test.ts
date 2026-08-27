import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushConfig } from "./config.js";
import { buildAttentionPushPayload, buildTurnEndPushPayload } from "./push-payload.js";
import { PushService, type PushSender } from "./push-service.js";
import { PushSubscriptionStore, type StoredPushSubscription } from "./push-store.js";
import type { AttentionRequest } from "../protocol.js";

const config: WebPushConfig = {
  publicKey: "BF1JW243veaons7uO0bcdtRHXVUTVJ74A_OzX7wiGhY114OpWvn0BOBrfXu2AhV3cmc0Nrb_LIRZHbFY4L8Xmgw",
  privateKey: "IPDx2j8nr-ShPjNWSqXsCAK3fA0W2cM78tjLvtG0jLA",
  subject: "mailto:operator@example.test",
};

const attention: AttentionRequest = {
  id: "attention-1",
  agentId: "agent-1",
  kind: "question",
  title: "Which branch?",
  revision: 2,
  options: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

let root: string;
let store: PushSubscriptionStore;

function subscription(endpoint: string, turnEnd?: boolean): StoredPushSubscription {
  return {
    endpoint,
    ...(turnEnd === undefined ? {} : { turnEnd }),
    p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU",
    auth: "3v0fHqQhH3xQ1r6mB3dOsg",
    sessionId: "session-a",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "push-service-"));
  store = new PushSubscriptionStore(path.join(root, "push-subscriptions.json"));
  await store.load();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("PushService", () => {
  it("sends the payload to every registered device", async () => {
    await store.upsert(subscription("https://push.example.test/phone"));
    await store.upsert(subscription("https://push.example.test/tablet"));
    const send = vi.fn<PushSender>(async () => ({ statusCode: 201 }));

    await new PushService(store, config, send).notify(buildAttentionPushPayload(attention, "release-planning", 1));

    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0][1] as string)).toMatchObject({
      title: "release-planning",
      body: "Waiting on your answer",
      badge: 1,
    });
  });

  /* The opt-in, enforced where it matters. A turn ends far more often than a
     question gets asked, so a device that asked only to be told about questions
     must not start being told about endings — and the store is the only place
     that knows which is which. */
  it("sends a finished turn only to the devices that asked for one", async () => {
    await store.upsert(subscription("https://push.example.test/opted-in", true));
    await store.upsert(subscription("https://push.example.test/opted-out", false));
    await store.upsert(subscription("https://push.example.test/never-asked"));
    const send = vi.fn<PushSender>(async () => ({ statusCode: 201 }));
    const service = new PushService(store, config, send);

    await service.notify(buildTurnEndPushPayload("agent-1", "release-planning", "complete", 0), "turnEnd");
    expect(send.mock.calls.map((call) => (call[0] as StoredPushSubscription).endpoint))
      .toEqual(["https://push.example.test/opted-in"]);

    // An attention request still reaches everyone: that is the notification
    // they all asked for by turning notifications on at all.
    send.mockClear();
    await service.notify(buildAttentionPushPayload(attention, "release-planning", 1));
    expect(send).toHaveBeenCalledTimes(3);
  });

  // A push service reporting the endpoint gone is the only automatic way a
  // record leaves the store. Without it, dead endpoints are retried forever.
  it("forgets an endpoint the push service reports gone", async () => {
    await store.upsert(subscription("https://push.example.test/gone"));
    await store.upsert(subscription("https://push.example.test/live"));
    const send = vi.fn<PushSender>(async (target) => ({
      statusCode: target.endpoint.endsWith("/gone") ? 410 : 201,
    }));

    await new PushService(store, config, send).notify(buildAttentionPushPayload(attention, "a", 1));

    expect(store.list().map((record) => record.endpoint)).toEqual(["https://push.example.test/live"]);
  });

  it("forgets an endpoint when the sender throws a 404", async () => {
    await store.upsert(subscription("https://push.example.test/gone"));
    const send = vi.fn<PushSender>(() => Promise.reject(Object.assign(new Error("gone"), { statusCode: 404 })));

    await new PushService(store, config, send).notify(buildAttentionPushPayload(attention, "a", 1));

    expect(store.list()).toEqual([]);
  });

  // A slow or broken push service must not propagate back into the daemon's
  // attention path, and a transient failure must not lose the subscription.
  it("swallows a transient failure and keeps the subscription", async () => {
    await store.upsert(subscription("https://push.example.test/flaky"));
    const send = vi.fn<PushSender>(() => Promise.reject(Object.assign(new Error("boom"), { statusCode: 503 })));

    await expect(new PushService(store, config, send).notify(buildAttentionPushPayload(attention, "a", 1)))
      .resolves.toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("never writes an endpoint into the failure log", async () => {
    await store.upsert(subscription("https://push.example.test/secret-device-id"));
    const send = vi.fn<PushSender>(() => Promise.reject(Object.assign(new Error("boom"), { statusCode: 500 })));

    await new PushService(store, config, send).notify(buildAttentionPushPayload(attention, "a", 1));

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret-device-id");
  });

  it("does nothing when no device has subscribed", async () => {
    const send = vi.fn<PushSender>(async () => ({ statusCode: 201 }));
    await new PushService(store, config, send).notify(buildAttentionPushPayload(attention, "a", 0));
    expect(send).not.toHaveBeenCalled();
  });
});
