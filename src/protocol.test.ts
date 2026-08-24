import { describe, expect, it } from "vitest";
import {
  bootstrapResponseSchema,
  directoryListingSchema,
  executeSlashCommandRequestSchema,
  mutationAcceptedSchema,
  problemDetailsSchema,
  sendMessageRequestSchema,
  serverFrameSchema,
  sessionCreatedSchema,
  slashCommandAcceptedSchema,
  slashCommandCatalogSchema,
  slashCommandResultSchema,
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

describe("slash command catalog schema", () => {
  it("accepts a well-formed catalog", () => {
    expect(slashCommandCatalogSchema.safeParse({
      agentId: "agent-1",
      agentRevision: 3,
      partial: false,
      commands: [{
        name: "goal",
        description: "Manage the agent's goal",
        source: "session",
        availability: "available",
        takesArguments: true,
        options: [{ value: "status", label: "Status", current: true }],
      }],
    }).success).toBe(true);
  });

  it("rejects a command entry with an invalid availability value", () => {
    expect(slashCommandCatalogSchema.safeParse({
      agentId: "agent-1",
      agentRevision: 3,
      partial: false,
      commands: [{
        name: "goal",
        description: "Manage the agent's goal",
        source: "session",
        availability: "sometimes",
        takesArguments: true,
      }],
    }).success).toBe(false);
  });
});

describe("directory listing schema", () => {
  it("accepts a well-formed listing", () => {
    expect(directoryListingSchema.safeParse({
      path: "/workspace",
      home: "/home/user",
      crumbs: [{ name: "workspace", path: "/workspace", hidden: false }],
      entries: [{ name: "src", path: "/workspace/src", hidden: false }],
      truncated: false,
    }).success).toBe(true);
  });

  it("rejects an entry missing the required hidden flag", () => {
    expect(directoryListingSchema.safeParse({
      path: "/workspace",
      home: "/home/user",
      crumbs: [],
      entries: [{ name: "src", path: "/workspace/src" }],
      truncated: false,
    }).success).toBe(false);
  });
});

describe("slash command result schema", () => {
  it("accepts each discriminated variant", () => {
    expect(slashCommandResultSchema.safeParse({ kind: "session_accepted" }).success).toBe(true);
    expect(slashCommandResultSchema.safeParse({
      kind: "heartbeat",
      status: "active",
      schedule: "*/5 * * * *",
      deliveryMode: "steer",
    }).success).toBe(true);
  });

  it("rejects an unknown heartbeat status", () => {
    expect(slashCommandResultSchema.safeParse({
      kind: "heartbeat",
      status: "sleeping",
    }).success).toBe(false);
  });

  it("rejects an unrecognized kind", () => {
    expect(slashCommandResultSchema.safeParse({ kind: "unknown_kind" }).success).toBe(false);
  });
});

describe("mutation accepted schema", () => {
  it("accepts a well-formed acceptance", () => {
    expect(mutationAcceptedSchema.safeParse({
      accepted: true,
      requestId: "11111111-1111-4111-8111-111111111111",
      revision: 4,
    }).success).toBe(true);
  });

  it("rejects accepted: false", () => {
    expect(mutationAcceptedSchema.safeParse({
      accepted: false,
      requestId: "11111111-1111-4111-8111-111111111111",
      revision: 4,
    }).success).toBe(false);
  });
});

describe("slash command accepted schema", () => {
  it("accepts an acceptance carrying a slash command result", () => {
    expect(slashCommandAcceptedSchema.safeParse({
      accepted: true,
      requestId: "11111111-1111-4111-8111-111111111111",
      revision: 4,
      result: { kind: "model", provider: "openai", modelId: "example" },
    }).success).toBe(true);
  });

  it("rejects a missing result", () => {
    expect(slashCommandAcceptedSchema.safeParse({
      accepted: true,
      requestId: "11111111-1111-4111-8111-111111111111",
      revision: 4,
    }).success).toBe(false);
  });
});

describe("session created schema", () => {
  it("accepts a well-formed session", () => {
    expect(sessionCreatedSchema.safeParse({
      requestId: "11111111-1111-4111-8111-111111111111",
      agentId: "agent-1",
    }).success).toBe(true);
  });

  it("rejects a session missing an agentId", () => {
    expect(sessionCreatedSchema.safeParse({
      requestId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
  });
});

describe("problem details schema", () => {
  it("accepts a well-formed problem", () => {
    expect(problemDetailsSchema.safeParse({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "No such agent",
    }).success).toBe(true);
  });

  it("rejects a problem with a non-numeric status", () => {
    expect(problemDetailsSchema.safeParse({
      type: "about:blank",
      title: "Not Found",
      status: "404",
    }).success).toBe(false);
  });
});
