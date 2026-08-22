import { describe, expect, it } from "vitest";
import type { AgentSnapshot, GatewayEvent } from "../protocol";
import { applyGatewayEvent, imageInputsForRequest, reconcilePending } from "./gateway-store";

const snapshot: AgentSnapshot = {
  revision: 1,
  agentId: "agent-1",
  messages: [],
  activity: [],
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
        { id: "a", agentId: "agent-1", kind: "approval", title: "A", revision: 1, options: [], createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", agentId: "agent-1", kind: "question", title: "B", revision: 1, options: [], createdAt: "2026-01-01T00:00:00.000Z" },
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
