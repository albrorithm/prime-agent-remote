import { describe, expect, it } from "vitest";
import { agentSnapshotSchema, cellOutputSchema, sessionDashboardSchema } from "./protocol.js";

function snapshotWith(presentation: unknown): unknown {
  return {
    revision: 1,
    agentId: "agent-1",
    messages: [{
      id: "message-1",
      role: "assistant",
      text: "row",
      state: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: "turn-1",
      presentation,
    }],
    attention: [],
  };
}

describe("transcript presentation schemas", () => {
  const cases: Array<{ kind: string; valid: unknown; invalid: unknown }> = [
    {
      kind: "thinking",
      valid: { kind: "thinking", full: "Full thought text", truncated: true },
      invalid: { kind: "thinking", full: 42 },
    },
    {
      kind: "tool",
      valid: { kind: "tool", label: "bash", status: "complete", meta: "↑ 1 ↓ 2 lines" },
      invalid: { kind: "tool", status: "complete" },
    },
    {
      kind: "python",
      valid: {
        kind: "python",
        lang: "python",
        status: "failed",
        preview: "run_check()",
        meta: "↑ 3 lines · 1.2s · ValueError",
        code: "run_check()",
        codeTruncated: true,
        stdout: "out",
        stderr: "err",
        result: "None",
        error: { ename: "ValueError", evalue: "boom", traceback: "Traceback…", tracebackTruncated: true },
        diffs: [{ path: "src/a.ts", oldStr: "a", newStr: "b", startLine: 3, truncated: true }],
        diffsTruncated: true,
        durationMs: 1200,
        kernelRestarted: true,
        cellId: "cell_abc",
      },
      invalid: { kind: "python", lang: "ruby", status: "complete", preview: "x" },
    },
    {
      kind: "refine",
      valid: {
        kind: "refine",
        status: "complete",
        summary: "Tightened the prompt",
        scope: "local",
        rollback: true,
        edits: [{ action: "update", kind: "prompt", title: "T", reason: "R", applied: true }],
      },
      invalid: { kind: "refine", status: "exploded", summary: "x" },
    },
    {
      kind: "notice",
      valid: { kind: "notice", label: "Context compacted", tone: "info" },
      invalid: { kind: "notice", label: "Context compacted", tone: "loud" },
    },
    {
      kind: "error",
      valid: { kind: "error", label: "Turn failed" },
      invalid: { kind: "error" },
    },
  ];

  for (const { kind, valid, invalid } of cases) {
    it(`accepts a valid ${kind} presentation and rejects a malformed one`, () => {
      expect(agentSnapshotSchema.safeParse(snapshotWith(valid)).success).toBe(true);
      expect(agentSnapshotSchema.safeParse(snapshotWith(invalid)).success).toBe(false);
    });
  }

  it("rejects unknown presentation kinds and accepts presentation-free rows", () => {
    expect(agentSnapshotSchema.safeParse(snapshotWith({ kind: "hologram" })).success).toBe(false);
    expect(agentSnapshotSchema.safeParse(snapshotWith(undefined)).success).toBe(true);
  });
});

describe("session dashboard schema", () => {
  it("accepts a full dashboard and rejects a malformed child status", () => {
    const dashboard = {
      status: "responding",
      recap: "Testing the drawer",
      needsInput: true,
      contextUsage: { tokens: 5_000, contextWindow: 100_000, percent: 5 },
      children: [{
        id: "agent-1:child:agent_abc",
        agentId: "agent_abc",
        name: "Subagent",
        status: "running",
        toolName: "ipython",
        durationMs: 1_000,
        answerPreview: "Preview",
        toolUseCount: 3,
        tokenCount: 1_234,
        recap: "Working",
      }],
      refines: [{
        id: "message-9",
        status: "complete",
        summary: "Tightened the prompt",
        scope: "global",
        rollback: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    };
    expect(sessionDashboardSchema.safeParse(dashboard).success).toBe(true);
    expect(sessionDashboardSchema.safeParse({
      ...dashboard,
      children: [{ id: "x", name: "Subagent", status: "exploded" }],
    }).success).toBe(false);
  });
});

describe("cell output schema", () => {
  it("requires a cell id and the truncated flag", () => {
    expect(cellOutputSchema.safeParse({
      cellId: "cell_abc",
      code: "print('hi')",
      stdout: "hi\n",
      truncated: false,
    }).success).toBe(true);
    expect(cellOutputSchema.safeParse({ cellId: "", truncated: false }).success).toBe(false);
    expect(cellOutputSchema.safeParse({ cellId: "cell_abc" }).success).toBe(false);
  });
});
