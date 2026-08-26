import { describe, expect, it } from "vitest";
import type { AttentionRequest } from "../protocol.js";
import {
  buildAttentionPushPayload,
  MAX_PUSH_AGENT_NAME_CHARS,
} from "./push-payload.js";

function attention(overrides: Partial<AttentionRequest> = {}): AttentionRequest {
  return {
    id: "attention-1",
    agentId: "agent-1",
    kind: "dialog",
    title: "Run migrations against production?",
    detail: "This will drop the sessions table and recreate it from scratch.",
    revision: 4,
    options: [
      { id: "confirm", label: "Yes, drop the sessions table", tone: "safe" },
      { id: "__prime_cancel__", label: "Decline", tone: "danger" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildAttentionPushPayload", () => {
  /**
   * The single most important property in the push feature. Agent output must
   * never reach a lock screen, so every field the daemon can influence with
   * model or tool text is checked against the built payload.
   */
  it("carries no attention title, detail, or option label, however tempting", () => {
    const sentinels = [
      "SENTINEL-TITLE-must-not-leak",
      "SENTINEL-DETAIL-must-not-leak",
      "SENTINEL-OPTION-must-not-leak",
      "SENTINEL-CANCEL-must-not-leak",
    ];
    const payload = buildAttentionPushPayload(attention({
      title: sentinels[0],
      detail: sentinels[1],
      options: [
        { id: "confirm", label: sentinels[2], tone: "safe" },
        { id: "__prime_cancel__", label: sentinels[3], tone: "danger" },
      ],
    }), "release-planning", 2);

    const serialized = JSON.stringify(payload);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(payload).toEqual({
      version: 1,
      title: "release-planning",
      body: "Waiting on your decision",
      kind: "dialog",
      agentId: "agent-1",
      attentionId: "attention-1",
      badge: 2,
    });
  });

  it("says what kind of attention it is without saying what it is about", () => {
    expect(buildAttentionPushPayload(attention({ kind: "dialog" }), "a", 1).body).toBe("Waiting on your decision");
    expect(buildAttentionPushPayload(attention({ kind: "question" }), "a", 1).body).toBe("Waiting on your answer");
    expect(buildAttentionPushPayload(attention({ kind: "error" }), "a", 1).body).toBe("Hit an error and stopped");
  });

  it("names the app when the session has no usable name", () => {
    expect(buildAttentionPushPayload(attention(), undefined, 1).title).toBe("Prime Agent");
    expect(buildAttentionPushPayload(attention(), "   ", 1).title).toBe("Prime Agent");
  });

  // A session name is user- or daemon-supplied and has no length bound of its
  // own; a lock screen truncates arbitrarily, so do it deliberately.
  it("truncates a long session name", () => {
    const title = buildAttentionPushPayload(attention(), "n".repeat(400), 1).title;
    expect(title).toHaveLength(MAX_PUSH_AGENT_NAME_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });

  it("normalizes a nonsensical badge count to zero", () => {
    for (const badge of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(buildAttentionPushPayload(attention(), "a", badge).badge).toBe(0);
    }
  });
});
