import { describe, expect, it } from "vitest";
import {
  sessionNameSchema,
  catalogSnapshotSchema,
  slashCommandCatalogSchema,
  slashCommandResultSchema,
  sendMessageRequestSchema,
  attentionResponseSchema,
  abortRequestSchema,
  createSessionRequestSchema,
  pairRequestSchema,
  agentSnapshotSchema,
  attentionAgentCount,
  buildPairingUrl,
  cellOutputSchema,
  readPairingFragment,
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
        backgroundOutput: "late thread output",
        backgroundOutputTruncated: true,
        codeLang: "python",
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
      backgroundOutput: "from a thread\n",
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

const TOKEN = "9hIe-0eiCAcRa4iGOGWCrqOMD5DQ_fwD1e7jND4MO9I";

describe("pairing links", () => {
  it("puts the token in the fragment, where no request can carry it", () => {
    const url = buildPairingUrl("https://host.tailnet.ts.net", TOKEN);
    expect(url).toBe(`https://host.tailnet.ts.net/#pair=${TOKEN}`);
    // Nothing before the # says anything about a token.
    expect(new URL(url).search).toBe("");
  });

  it("round-trips through the fragment it writes", () => {
    const url = new URL(buildPairingUrl("http://machine.local:8787", TOKEN));
    expect(readPairingFragment(url.hash)).toBe(TOKEN);
  });

  it("reads a fragment with or without its hash", () => {
    expect(readPairingFragment(`#pair=${TOKEN}`)).toBe(TOKEN);
    expect(readPairingFragment(`pair=${TOKEN}`)).toBe(TOKEN);
  });

  /* Spending a token costs one of five pairing attempts per minute for the
     whole address, and behind a proxy that is every device in the house. A
     fragment left over from something else does not get to spend one. */
  it("refuses anything that is not shaped like a token", () => {
    expect(readPairingFragment("")).toBeNull();
    expect(readPairingFragment("#")).toBeNull();
    expect(readPairingFragment("#section-heading")).toBeNull();
    expect(readPairingFragment("#agent=agent-7")).toBeNull();
    expect(readPairingFragment("#pair=")).toBeNull();
    expect(readPairingFragment("#pair=short")).toBeNull();
    expect(readPairingFragment(`#pair=${"x".repeat(31)}`)).toBeNull();
    expect(readPairingFragment(`#pair=${"x".repeat(32)}`)).toBe("x".repeat(32));
    expect(readPairingFragment(`#pair=${TOKEN}!`)).toBeNull();
    expect(readPairingFragment(`#pair=${TOKEN}&pair=other`)).toBeNull();
  });

  it("finds the token beside other fragment parameters", () => {
    expect(readPairingFragment(`#state=1&pair=${TOKEN}`)).toBe(TOKEN);
  });
});

describe("catalog snapshot schema", () => {
  it("preserves notificationLabel through a client-side parse", () => {
    const parsed = catalogSnapshotSchema.parse({
      revision: 1,
      agents: [summary({ id: "a", notificationLabel: "release-planning" })],
    });
    expect(parsed.agents[0].notificationLabel).toBe("release-planning");
  });

  it("leaves notificationLabel absent when the agent carries none", () => {
    const parsed = catalogSnapshotSchema.parse({ revision: 1, agents: [summary({ id: "a" })] });
    expect(parsed.agents[0].notificationLabel).toBeUndefined();
  });
});

describe("slash command catalog entry schema", () => {
  it("no longer accepts not_supported_on_mobile as an unavailableReason", () => {
    const catalog = {
      agentId: "agent-1",
      agentRevision: 1,
      partial: false,
      commands: [{
        name: "context",
        description: "Context usage",
        source: "adapter",
        availability: "unavailable",
        unavailableReason: "not_supported_on_mobile",
        takesArguments: false,
      }],
    };
    expect(slashCommandCatalogSchema.safeParse(catalog).success).toBe(false);
    expect(slashCommandCatalogSchema.safeParse({
      ...catalog,
      commands: [{ ...catalog.commands[0], unavailableReason: "adapter_missing" }],
    }).success).toBe(true);
  });
});

describe("slash command result schema", () => {
  it("no longer requires availableLevels on an effort result", () => {
    const result = slashCommandResultSchema.parse({ kind: "effort", level: "high" });
    expect(result).toEqual({ kind: "effort", level: "high" });
    expect(slashCommandResultSchema.safeParse({ kind: "effort" }).success).toBe(true);
    expect(slashCommandResultSchema.parse({ kind: "effort", level: "high", availableLevels: ["low", "high"] }))
      .toEqual({ kind: "effort", level: "high", availableLevels: ["low", "high"] });
  });
});

describe("strict mutation request schemas", () => {
  it("rejects an unknown field on sendMessageRequestSchema", () => {
    const base = { requestId: crypto.randomUUID(), expectedRevision: 1, text: "hi" };
    expect(sendMessageRequestSchema.safeParse(base).success).toBe(true);
    expect(sendMessageRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("rejects an unknown field on attentionResponseSchema", () => {
    const base = { requestId: crypto.randomUUID(), expectedRevision: 1, optionId: "confirm" };
    expect(attentionResponseSchema.safeParse(base).success).toBe(true);
    expect(attentionResponseSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("rejects an unknown field on abortRequestSchema", () => {
    const base = { requestId: crypto.randomUUID(), expectedRevision: 1 };
    expect(abortRequestSchema.safeParse(base).success).toBe(true);
    expect(abortRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("rejects an unknown field on createSessionRequestSchema", () => {
    const base = { requestId: crypto.randomUUID(), cwd: "/projects/example" };
    expect(createSessionRequestSchema.safeParse(base).success).toBe(true);
    expect(createSessionRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("rejects an unknown field on pairRequestSchema", () => {
    const base = { token: TOKEN };
    expect(pairRequestSchema.safeParse(base).success).toBe(true);
    expect(pairRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});
