import { describe, expect, it } from "vitest";
import {
  bootstrapResponseSchema,
  executeSlashCommandRequestSchema,
  sendMessageRequestSchema,
  serverFrameSchema,
  EXECUTABLE_SLASH_COMMAND_NAMES,
} from "./protocol";

const valid = {
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 3,
  name: "goal",
  args: "status",
};

describe("slash command requests", () => {
  it("accepts the explicitly executable commands", () => {
    for (const name of EXECUTABLE_SLASH_COMMAND_NAMES) {
      expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name }).success).toBe(true);
    }
  });

  it("keeps slash input out of the ordinary prompt endpoint", () => {
    expect(sendMessageRequestSchema.safeParse({
      requestId: valid.requestId,
      expectedRevision: 3,
      text: "/model gpt",
      images: [],
    }).success).toBe(false);
  });

  it("accepts conservative command tokens but rejects malformed, multiline, oversized, and extra input", () => {
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "settings" }).success).toBe(true);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "detected-extension" }).success).toBe(true);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "../../invalid" }).success).toBe(false);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "bad command" }).success).toBe(false);
    for (const separator of ["\r", "\n", "\u2028", "\u2029"]) {
      expect(executeSlashCommandRequestSchema.safeParse({ ...valid, args: `status${separator}now` }).success).toBe(false);
    }
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, args: "x".repeat(4_001) }).success).toBe(false);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});


describe("runtime server protocol validation", () => {
  const capabilities = {
    send: true,
    abort: true,
    resume: false,
    rename: false,
    stop: false,
    deactivate: false,
    delete: false,
    respond: true,
    images: true,
  };
  const catalog = {
    revision: 1,
    agents: [{
      id: "agent-1",
      rootId: "agent-1",
      parentId: null,
      depth: 0,
      name: "Agent",
      lifecycle: "live",
      activity: "idle",
      attention: null,
      unreadCount: 0,
      childCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      capabilities,
    }],
  };

  it("rejects a bootstrap from another protocol version", () => {
    expect(bootstrapResponseSchema.safeParse({
      protocolVersion: 2,
      csrfToken: "csrf",
      backend: "demo",
      catalog,
    }).success).toBe(false);
  });

  it("rejects mismatched snapshot and replay streams", () => {
    const snapshot = { revision: 1, agentId: "agent-1", messages: [], activity: [], attention: [] };
    expect(serverFrameSchema.safeParse({
      type: "snapshot",
      version: 1,
      streamId: "agent:other",
      cursor: { epoch: "epoch", seq: 0 },
      snapshot,
    }).success).toBe(false);
    expect(serverFrameSchema.safeParse({
      type: "replay",
      version: 1,
      streamId: "catalog",
      cursor: { epoch: "epoch", seq: 1 },
      events: [{
        version: 1,
        streamId: "agent:agent-1",
        epoch: "epoch",
        seq: 1,
        emittedAt: "2026-01-01T00:00:00.000Z",
        event: { kind: "agent.replaced", payload: snapshot },
      }],
    }).success).toBe(false);
  });
});
