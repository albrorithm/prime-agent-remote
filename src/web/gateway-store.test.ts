import { describe, expect, it } from "vitest";
import type { AgentSnapshot, GatewayEvent } from "../protocol";
import { applyGatewayEvent } from "./gateway-store";

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
});
