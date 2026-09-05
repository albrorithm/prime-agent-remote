import { describe, expect, it } from "vitest";
import type { AgentSnapshot, GatewayEvent } from "../protocol";
import { applyGatewayEvent, imageInputsForRequest, reconcilePending, reconcileOlderRows, retireRemovedRows } from "./gateway-store";

const snapshot: AgentSnapshot = {
  revision: 1,
  agentId: "agent-1",
  messages: [],
  attention: [],
};

describe("applyGatewayEvent", () => {
  it("adds and updates a streaming message by stable id", () => {
    const added: GatewayEvent = {
      kind: "agent.message_added",
      payload: { id: "message-1", role: "assistant", text: "Hel", state: "streaming", createdAt: "2026-01-01T00:00:00.000Z" },
    };
    const updated: GatewayEvent = {
      kind: "agent.message_updated",
      payload: { ...added.payload, text: "Hello", state: "complete" },
    };
    const first = applyGatewayEvent(snapshot, added);
    const second = applyGatewayEvent(first, updated);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ id: "message-1", text: "Hello", state: "complete" });
  });

  it("resolves attention without disturbing other requests", () => {
    const withAttention: AgentSnapshot = {
      ...snapshot,
      attention: [
        { id: "a", agentId: "agent-1", kind: "dialog", title: "A", revision: 1, reply: { kind: "choice" }, options: [], createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", agentId: "agent-1", kind: "question", title: "B", revision: 1, reply: { kind: "choice" }, options: [], createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    const result = applyGatewayEvent(withAttention, { kind: "agent.attention_resolved", payload: { id: "a" } });
    expect(result.attention.map((item) => item.id)).toEqual(["b"]);
  });

  it("does not let a lower-revision replacement erase newer state", () => {
    const newer = { ...snapshot, revision: 5, messages: [{
      id: "new",
      role: "assistant" as const,
      text: "newer",
      state: "complete" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    }] };
    const result = applyGatewayEvent(newer, {
      kind: "agent.replaced",
      payload: { ...snapshot, revision: 4 },
    });
    expect(result).toBe(newer);
  });

  it("carries a replacement's queue through untouched", () => {
    const withQueue: AgentSnapshot = {
      ...snapshot,
      revision: 2,
      queue: {
        steering: [{ text: "do this next", truncated: false }],
        followUp: [],
        queuedCount: 1,
      },
    };
    const result = applyGatewayEvent(snapshot, { kind: "agent.replaced", payload: withQueue });
    expect(result).toBe(withQueue);
    expect(result.queue).toEqual(withQueue.queue);
  });

  const message = (id: string, text: string) => ({
    id,
    role: "assistant" as const,
    text,
    state: "complete" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("applies a patch's removed, updated and added rows in order, leaving untouched rows the same objects", () => {
    const m1 = message("m1", "one");
    const m2 = message("m2", "two");
    const m3 = message("m3", "three");
    const base: AgentSnapshot = { ...snapshot, revision: 1, messages: [m1, m2, m3] };
    const m1Updated = message("m1", "one (edited)");
    const m4 = message("m4", "four");
    const result = applyGatewayEvent(base, {
      kind: "agent.patched",
      payload: { revision: 2, removed: ["m2"], updated: [m1Updated], added: [m4] },
    });
    expect(result.messages.map((item) => item.id)).toEqual(["m1", "m3", "m4"]);
    expect(result.messages[0]).toBe(m1Updated);
    expect(result.messages[1]).toBe(m3);
    expect(result.revision).toBe(2);
  });

  it("upserts an added row whose id already exists in place, rather than duplicating it", () => {
    const m1 = message("m1", "one");
    const m2 = message("m2", "two");
    const base: AgentSnapshot = { ...snapshot, revision: 1, messages: [m1, m2] };
    const m1Replacement = message("m1", "one (again)");
    const result = applyGatewayEvent(base, {
      kind: "agent.patched",
      payload: { revision: 2, added: [m1Replacement] },
    });
    expect(result.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(result.messages[0]).toBe(m1Replacement);
  });

  it("removes the goal when a patch sets it to null", () => {
    const base: AgentSnapshot = {
      ...snapshot,
      revision: 1,
      goal: { status: "active", objective: "ship it", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
    };
    const result = applyGatewayEvent(base, { kind: "agent.patched", payload: { revision: 2, goal: null } });
    expect(result.goal).toBeUndefined();
  });

  it("replaces the queue a patch carries", () => {
    const base: AgentSnapshot = { ...snapshot, revision: 1 };
    const queue = { steering: [{ text: "next", truncated: false }], followUp: [], queuedCount: 1 };
    const result = applyGatewayEvent(base, { kind: "agent.patched", payload: { revision: 2, queue } });
    expect(result.queue).toEqual(queue);
  });

  it("ignores a patch at or below the snapshot's revision", () => {
    const base: AgentSnapshot = { ...snapshot, revision: 5, messages: [message("m1", "one")] };
    const stale = applyGatewayEvent(base, { kind: "agent.patched", payload: { revision: 5, added: [message("m2", "two")] } });
    expect(stale).toBe(base);
    const older = applyGatewayEvent(base, { kind: "agent.patched", payload: { revision: 3, added: [message("m2", "two")] } });
    expect(older).toBe(base);
  });
});

describe("reconcilePending", () => {
  const pending = [
    { id: "p1", text: "hello", createdAt: "2026-01-01T00:00:00.000Z", knownUserMessageIds: [] },
    { id: "p2", text: "again", createdAt: "2026-01-01T00:00:01.000Z", knownUserMessageIds: [] },
  ];

  it("drops pending messages once the server echoes them", () => {
    const messages = [{ id: "m1", role: "user" as const, text: "hello", state: "complete" as const, createdAt: "2026-01-01T00:00:02.000Z" }];
    expect(reconcilePending(pending, messages).map((item) => item.id)).toEqual(["p2"]);
  });

  it("matches repeated sends one-to-one and ignores messages known before submission", () => {
    const repeated = [
      { id: "p1", text: "same", createdAt: "2026-01-01T00:00:01.000Z", knownUserMessageIds: ["old"] },
      { id: "p2", text: "same", createdAt: "2026-01-01T00:00:02.000Z", knownUserMessageIds: ["old"] },
    ];
    const messages = [
      { id: "old", role: "user" as const, text: "same", state: "complete" as const, createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "new", role: "user" as const, text: "same", state: "complete" as const, createdAt: "2026-01-01T00:00:03.000Z" },
    ];
    expect(reconcilePending(repeated, messages).map((item) => item.id)).toEqual(["p2"]);
  });

  it("does not reuse a consumed echo on the next reconciliation", () => {
    const repeated = [
      { id: "p1", text: "same", createdAt: "2026-01-01T00:00:01.000Z", knownUserMessageIds: [] },
      { id: "p2", text: "same", createdAt: "2026-01-01T00:00:02.000Z", knownUserMessageIds: [] },
    ];
    const messages = [{ id: "echo", role: "user" as const, text: "same", state: "complete" as const, createdAt: "2026-01-01T00:00:03.000Z" }];
    const first = reconcilePending(repeated, messages);
    expect(first.map((item) => item.id)).toEqual(["p2"]);
    expect(first[0].knownUserMessageIds).toContain("echo");
    expect(reconcilePending(first, messages).map((item) => item.id)).toEqual(["p2"]);
  });

  it("keeps everything while the server has not echoed", () => {
    expect(reconcilePending(pending, [])).toHaveLength(2);
  });

  it("ignores assistant messages with matching text", () => {
    const messages = [{ id: "m1", role: "assistant" as const, text: "hello", state: "complete" as const, createdAt: "2026-01-01T00:00:02.000Z" }];
    expect(reconcilePending(pending, messages)).toHaveLength(2);
  });

  it("waits for the matching attachment count before clearing an image-only send", () => {
    const imagePending = [{
      id: "image-pending",
      text: "Image attached.",
      createdAt: "2026-01-01T00:00:00.000Z",
      knownUserMessageIds: [],
      attachments: [{ mimeType: "image/jpeg" as const, previewUrl: "blob:preview" }],
    }];
    const textOnly = [{
      id: "m1",
      role: "user" as const,
      text: "Image attached.",
      state: "complete" as const,
      createdAt: "2026-01-01T00:00:02.000Z",
    }];
    expect(reconcilePending(imagePending, textOnly)).toHaveLength(1);
    expect(reconcilePending(imagePending, [{
      ...textOnly[0],
      attachments: [{ id: "image_safe", type: "image" as const, mimeType: "image/jpeg" as const }],
    }])).toEqual([]);
  });
});


describe("imageInputsForRequest", () => {
  it("strips browser-only preview URLs before transmission", () => {
    const inputs = imageInputsForRequest([{
      type: "image",
      mimeType: "image/jpeg",
      data: "canonical-base64",
      previewUrl: "blob:browser-only-preview",
      previewBlob: new Blob(["preview"], { type: "image/jpeg" }),
    }]);
    expect(inputs).toEqual([{ type: "image", mimeType: "image/jpeg", data: "canonical-base64" }]);
    expect(JSON.stringify(inputs)).not.toContain("browser-only-preview");
  });
});

describe("history buffer", () => {
  const row = (id: string) => ({ id, role: "assistant" as const, text: id, state: "complete" as const, createdAt: "2026-01-01T00:00:00.000Z" });
  const paged = (ids: string[]) => ({ ...snapshot, messages: ids.map(row), history: { olderCount: 0, exhaustive: true } });

  it("retires rows leaving the window's front, in order, and drops the rest", () => {
    const older = [row("h1")];
    const previous = [row("w1"), row("w2"), row("w3"), row("w4")];
    const retired = retireRemovedRows(older, previous, ["w1", "w2", "w4"]);
    expect(retired.map((item) => item.id)).toEqual(["h1", "w1", "w2"]);
    // The rows themselves move, not copies: the reader may be looking at them.
    expect(retired[1]).toBe(previous[0]);
    expect(retireRemovedRows(older, previous, undefined)).toBe(older);
    expect(retireRemovedRows(older, previous, ["w3"])).toBe(older);
  });

  it("keeps history across a replacement whose window still follows what is held", () => {
    const older = [row("h1"), row("h2")];
    const previous = [row("w1"), row("w2"), row("w3")];
    expect(reconcileOlderRows(older, previous, paged(["w2", "w3", "w4"])).map((item) => item.id)).toEqual(["h1", "h2", "w1"]);
    expect(reconcileOlderRows(older, previous, paged(["h2", "w1"])).map((item) => item.id)).toEqual(["h1"]);
  });

  it("starts history over when a replacement was rewritten or is not paged", () => {
    const older = [row("h1")];
    const previous = [row("w1")];
    expect(reconcileOlderRows(older, previous, paged(["x1", "x2"]))).toEqual([]);
    expect(reconcileOlderRows(older, previous, { ...snapshot, messages: [row("w1")] })).toEqual([]);
    expect(reconcileOlderRows([], [], paged(["w1"]))).toEqual([]);
  });
});
