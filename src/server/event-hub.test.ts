// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, CatalogSnapshot, ServerFrame, TranscriptMessage } from "../protocol.js";
import { EventHub } from "./event-hub.js";

function catalog(revision: number): CatalogSnapshot {
  return { revision, agents: [] };
}

function agentSnapshot(revision: number, messages: TranscriptMessage[] = []): AgentSnapshot {
  return { revision, agentId: "agent-one", messages, attention: [] };
}

describe("EventHub", () => {
  it("sends an initial snapshot before live events", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    const received: ServerFrame[] = [];
    const attached = hub.attach("catalog", null, (frame) => { received.push(frame); });
    expect(attached?.initial.type).toBe("snapshot");
    received.push(attached!.initial);
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2));
    expect(received.map((frame) => frame.type)).toEqual(["snapshot", "event"]);
    attached?.detach();
  });

  it("replays a covered sequence gap", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    hub.publish("catalog", { kind: "agent.attention_resolved", payload: { id: "one" } }, catalog(2));
    hub.publish("catalog", { kind: "agent.attention_resolved", payload: { id: "two" } }, catalog(3));
    const attached = hub.attach("catalog", { epoch: hub.epoch, seq: 0 }, vi.fn());
    expect(attached?.initial.type).toBe("replay");
    if (attached?.initial.type === "replay") {
      expect(attached.initial.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(attached.initial.cursor.seq).toBe(2);
    }
  });

  it("falls back to a snapshot when the ring no longer covers the cursor", () => {
    const hub = new EventHub(2, 64);
    hub.register("catalog", catalog(0));
    for (let revision = 1; revision <= 3; revision += 1) {
      hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(revision) }, catalog(revision));
    }
    const attached = hub.attach("catalog", { epoch: hub.epoch, seq: 0 }, vi.fn());
    expect(attached?.initial.type).toBe("snapshot");
    if (attached?.initial.type === "snapshot") expect(attached.initial.snapshot).toEqual(catalog(3));
  });

  it("uses a snapshot for a foreign gateway epoch", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    expect(hub.attach("catalog", { epoch: "old", seq: 20 }, vi.fn())?.initial.type).toBe("snapshot");
  });

  it("unregisters a stream and detaches its listeners", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    const received: ServerFrame[] = [];
    hub.attach("catalog", null, (frame) => { received.push(frame); });

    expect(hub.unregister("catalog")).toBe(true);
    expect(received).toContainEqual(expect.objectContaining({ type: "detached", reason: "stream_gone" }));
    expect(hub.has("catalog")).toBe(false);
    expect(hub.attach("catalog", null, vi.fn())).toBeNull();
  });

  it("isolates listener failures", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    const healthy = vi.fn();
    hub.attach("catalog", null, () => { throw new Error("broken listener"); });
    hub.attach("catalog", null, async () => { throw new Error("broken async listener"); });
    hub.attach("catalog", null, healthy);

    expect(() => hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2)))
      .not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("compacts replace events and enforces a replay byte budget", () => {
    const compacted = new EventHub();
    compacted.register("catalog", catalog(0));
    for (let revision = 1; revision <= 100; revision += 1) {
      compacted.publish("catalog", { kind: "catalog.replaced", payload: catalog(revision) }, catalog(revision));
    }
    expect(compacted.attach("catalog", { epoch: compacted.epoch, seq: 0 }, vi.fn())?.initial.type)
      .toBe("snapshot");

    const byteBounded = new EventHub(256, 64, 300);
    byteBounded.register("catalog", catalog(0));
    for (let revision = 1; revision <= 10; revision += 1) {
      byteBounded.publish(
        "catalog",
        { kind: "agent.attention_resolved", payload: { id: `attention-${revision}` } },
        catalog(revision),
      );
    }
    const oldCursor = byteBounded.attach("catalog", { epoch: byteBounded.epoch, seq: 0 }, vi.fn());
    expect(oldCursor?.initial.type).toBe("snapshot");
    if (oldCursor?.initial.type === "snapshot") expect(oldCursor.initial.snapshot).toEqual(catalog(10));
  });


  /* The epoch names the process, not a stream generation. A re-registered id
     used to restart its seq at 0 under the same epoch, so a cursor held from
     before the gap passed every check and was replayed only what sat above its
     old seq — silently missing everything the new generation had published.
     Ordinary, not exotic: the opaque id comes from session identity, so an
     agent that drops out of a catalog refresh and returns gets the same id. */
  it("answers a cursor from before a re-registration with a snapshot, not a partial replay", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2));
    const before = hub.attach("catalog", null, vi.fn())!;
    const staleCursor = { epoch: hub.epoch, seq: 1 };
    before.detach();
    hub.unregister("catalog");

    hub.register("catalog", catalog(3));
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(4) }, catalog(4));

    const resumed = hub.attach("catalog", staleCursor, vi.fn());
    expect(resumed?.initial.type).toBe("snapshot");
    if (resumed?.initial.type === "snapshot") expect(resumed.initial.snapshot).toEqual(catalog(4));
    resumed?.detach();
  });

  // Same discontinuity, but the new generation has published nothing yet: the
  // stream sits one past the high-water rather than on it, so the stale cursor
  // still fails coverage instead of being answered with an empty replay.
  it("answers a stale cursor with a snapshot even when the new stream is silent", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2));
    const staleCursor = { epoch: hub.epoch, seq: 1 };
    hub.unregister("catalog");

    hub.register("catalog", catalog(3));

    const resumed = hub.attach("catalog", staleCursor, vi.fn());
    expect(resumed?.initial.type).toBe("snapshot");
    if (resumed?.initial.type === "snapshot") expect(resumed.initial.snapshot).toEqual(catalog(3));
    resumed?.detach();
  });

  it("keeps stale detach tokens from retaining or detaching a replacement stream", () => {
    const hub = new EventHub();
    const listener = vi.fn();
    hub.register("catalog", catalog(1));
    const stale = hub.attach("catalog", null, listener)!;
    hub.unregister("catalog");

    hub.register("catalog", catalog(2));
    const current = hub.attach("catalog", null, listener)!;
    listener.mockClear();
    stale.detach();
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(3) }, catalog(3));

    expect(listener).toHaveBeenCalledTimes(1);
    current.detach();
  });

  it("is terminal after close", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    hub.close();
    hub.close();

    expect(hub.has("catalog")).toBe(false);
    expect(hub.attach("catalog", null, vi.fn())).toBeNull();
    expect(() => hub.register("catalog", catalog(2))).toThrow("EventHub is closed");
    expect(() => hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2)))
      .toThrow("EventHub is closed");
  });

  it("falls back to a snapshot across an oversized replay gap", () => {
    const hub = new EventHub(256, 64, 500);
    hub.register("agent:agent-one", agentSnapshot(0));
    hub.publish(
      "agent:agent-one",
      { kind: "agent.attention_resolved", payload: { id: "small-before" } },
      agentSnapshot(1),
    );
    const oversized: TranscriptMessage = {
      id: "oversized",
      role: "assistant",
      text: "x".repeat(2_000),
      state: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    hub.publish(
      "agent:agent-one",
      { kind: "agent.message_added", payload: oversized },
      agentSnapshot(2, [oversized]),
    );
    hub.publish(
      "agent:agent-one",
      { kind: "agent.attention_resolved", payload: { id: "small-after" } },
      agentSnapshot(3, [oversized]),
    );

    expect(hub.attach(
      "agent:agent-one",
      { epoch: hub.epoch, seq: 0 },
      vi.fn(),
    )?.initial.type).toBe("snapshot");
    const afterOversized = hub.attach(
      "agent:agent-one",
      { epoch: hub.epoch, seq: 2 },
      vi.fn(),
    );
    expect(afterOversized?.initial.type).toBe("replay");
    if (afterOversized?.initial.type === "replay") {
      expect(afterOversized.initial.events.map((event) => event.seq)).toEqual([3]);
    }
  });

});
