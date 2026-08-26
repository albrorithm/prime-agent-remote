import { describe, expect, it } from "vitest";
import {
  sessionNameSchema,
  agentSnapshotSchema,
  attentionAgentCount,
  cellOutputSchema,
  sessionDashboardSchema,
  type AgentSummary,
} from "./protocol.js";

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

function summary(overrides: Partial<AgentSummary> & Pick<AgentSummary, "id">): AgentSummary {
  return {
    rootId: overrides.id,
    parentId: null,
    depth: 0,
    name: overrides.id,
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: {
      send: true,
      abort: true,
      resume: false,
      rename: true,
      stop: true,
      deactivate: true,
      delete: true,
      respond: true,
      images: true,
    },
    ...overrides,
  };
}

describe("attentionAgentCount", () => {
  it("counts one per agent waiting on the user, whatever the attention kind", () => {
    expect(attentionAgentCount([
      summary({ id: "a", attention: "dialog" }),
      summary({ id: "b", attention: "question" }),
      summary({ id: "c", attention: "error" }),
      summary({ id: "d" }),
    ])).toBe(3);
  });

  it("counts a starting agent but never a dead one", () => {
    expect(attentionAgentCount([summary({ id: "a", attention: "dialog", lifecycle: "starting" })])).toBe(1);
    for (const lifecycle of ["stopped", "inactive", "failed"] as const) {
      expect(attentionAgentCount([summary({ id: "a", attention: "dialog", lifecycle })])).toBe(0);
    }
  });

  // The backends derive unreadCount as `attention ? 1 : 0`, so the two agree
  // today. Pinned so a projection change that breaks the tie is visible here.
  it("ignores unreadCount entirely", () => {
    expect(attentionAgentCount([summary({ id: "a", unreadCount: 7 })])).toBe(0);
  });

  it("is empty for an empty catalog", () => {
    expect(attentionAgentCount([])).toBe(0);
  });
});

describe("sessionNameSchema", () => {
  it("accepts a trimmed single-line label", () => {
    expect(sessionNameSchema.parse("  Mobile session  ")).toBe("Mobile session");
    expect(sessionNameSchema.parse("x".repeat(200))).toHaveLength(200);
  });

  it("refuses anything that is not a label", () => {
    // Empty or whitespace-only, over the bound, and every line break form: a
    // name lands in a list row and in the daemon's own session title.
    for (const value of ["", "   ", "x".repeat(201), "two\nlines", "carriage\rreturn", "line\u2028sep", "para\u2029sep", "null\u0000byte"]) {
      expect(sessionNameSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
