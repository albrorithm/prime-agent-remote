import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "../../protocol";
import { useReplyAnnouncer } from "./useReplyAnnouncer";

function message(overrides: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "state">): TranscriptMessage {
  return {
    role: "assistant",
    text: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("useReplyAnnouncer", () => {
  it("does not announce on the first snapshot for an agent (baseline only)", () => {
    const { result } = renderHook(
      ({ agentId, agentName, snapshot }) => useReplyAnnouncer(agentId, agentName, snapshot),
      {
        initialProps: {
          agentId: "agent-a" as string | null,
          agentName: "agent-a" as string | undefined,
          snapshot: { agentId: "agent-a", messages: [message({ id: "m1", state: "streaming" })] },
        },
      },
    );
    expect(result.current.text).toBe("");
  });

  it("announces a reply completing but not streaming token updates", () => {
    const { result, rerender } = renderHook(
      ({ agentId, agentName, snapshot }) => useReplyAnnouncer(agentId, agentName, snapshot),
      {
        initialProps: {
          agentId: "agent-a" as string | null,
          agentName: "agent-a" as string | undefined,
          snapshot: { agentId: "agent-a", messages: [message({ id: "m1", state: "streaming", text: "partial" })] },
        },
      },
    );
    expect(result.current.text).toBe("");

    rerender({
      agentId: "agent-a",
      agentName: "agent-a",
      snapshot: { agentId: "agent-a", messages: [message({ id: "m1", state: "streaming", text: "partial token" })] },
    });
    expect(result.current.text).toBe("");

    rerender({
      agentId: "agent-a",
      agentName: "agent-a",
      snapshot: { agentId: "agent-a", messages: [message({ id: "m1", state: "complete", text: "partial token done" })] },
    });
    expect(result.current.text).toBe("agent-a finished replying.");
  });

  it("announces a fresh reply and a failed reply, ignoring presentation messages", () => {
    const { result, rerender } = renderHook(
      ({ agentId, agentName, snapshot }) => useReplyAnnouncer(agentId, agentName, snapshot),
      {
        initialProps: {
          agentId: "agent-a" as string | null,
          agentName: "agent-a" as string | undefined,
          snapshot: { agentId: "agent-a", messages: [] as TranscriptMessage[] },
        },
      },
    );

    rerender({
      agentId: "agent-a",
      agentName: "agent-a",
      snapshot: {
        agentId: "agent-a",
        messages: [
          message({ id: "tool-1", state: "complete", presentation: { kind: "tool", label: "bash", status: "complete" } }),
          message({ id: "m1", state: "complete" }),
        ],
      },
    });
    expect(result.current.text).toBe("agent-a replied.");

    rerender({
      agentId: "agent-a",
      agentName: "agent-a",
      snapshot: {
        agentId: "agent-a",
        messages: [
          message({ id: "tool-1", state: "complete", presentation: { kind: "tool", label: "bash", status: "complete" } }),
          message({ id: "m1", state: "complete" }),
          message({ id: "m2", state: "failed" }),
        ],
      },
    });
    expect(result.current.text).toBe("agent-a's reply failed.");
  });

  it("uses the last matching message in a pass when multiple change state together", () => {
    const { rerender, result } = renderHook(
      ({ agentId, agentName, snapshot }) => useReplyAnnouncer(agentId, agentName, snapshot),
      {
        initialProps: {
          agentId: "agent-a" as string | null,
          agentName: "agent-a" as string | undefined,
          snapshot: {
            agentId: "agent-a",
            messages: [
              message({ id: "m1", state: "streaming" }),
              message({ id: "m2", state: "streaming" }),
            ],
          },
        },
      },
    );

    rerender({
      agentId: "agent-a",
      agentName: "agent-a",
      snapshot: {
        agentId: "agent-a",
        messages: [
          message({ id: "m1", state: "complete" }),
          message({ id: "m2", state: "failed" }),
        ],
      },
    });
    expect(result.current.text).toBe("agent-a's reply failed.");
  });

  it("resets the announcement and baseline when the selected agent changes", () => {
    const { result, rerender } = renderHook(
      ({ agentId, agentName, snapshot }) => useReplyAnnouncer(agentId, agentName, snapshot),
      {
        initialProps: {
          agentId: "agent-a" as string | null,
          agentName: "agent-a" as string | undefined,
          snapshot: { agentId: "agent-a", messages: [message({ id: "m1", state: "streaming" })] },
        },
      },
    );
    rerender({
      agentId: "agent-a",
      agentName: "agent-a",
      snapshot: { agentId: "agent-a", messages: [message({ id: "m1", state: "complete" })] },
    });
    expect(result.current.text).toBe("agent-a finished replying.");
    const previousKey = result.current.key;

    rerender({
      agentId: "agent-b",
      agentName: "agent-b",
      snapshot: { agentId: "agent-b", messages: [message({ id: "m2", state: "complete" })] },
    });
    expect(result.current.text).toBe("");
    expect(result.current.key).toBe(previousKey + 1);

    // New agent's first snapshot is a baseline, not an announcement.
    rerender({
      agentId: "agent-b",
      agentName: "agent-b",
      snapshot: { agentId: "agent-b", messages: [message({ id: "m2", state: "complete" })] },
    });
    expect(result.current.text).toBe("");
  });
});
