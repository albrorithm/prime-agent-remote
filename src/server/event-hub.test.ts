// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { CatalogSnapshot, ServerFrame } from "../protocol.js";
import { EventHub } from "./event-hub.js";

function catalog(revision: number): CatalogSnapshot {
  return { revision, agents: [] };
}

describe("EventHub", () => {
  it("sends an initial snapshot before live events", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    const received: ServerFrame[] = [];
    const attached = hub.attach("catalog", null, (frame) => received.push(frame));
    expect(attached?.initial.type).toBe("snapshot");
    received.push(attached!.initial);
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2));
    expect(received.map((frame) => frame.type)).toEqual(["snapshot", "event"]);
    attached?.detach();
  });

  it("replays a covered sequence gap", () => {
    const hub = new EventHub();
    hub.register("catalog", catalog(1));
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(2) }, catalog(2));
    hub.publish("catalog", { kind: "catalog.replaced", payload: catalog(3) }, catalog(3));
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
});
