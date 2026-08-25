import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../protocol";
import { agentStatus } from "./agent-status";

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "agent-1",
    rootId: "agent-1",
    parentId: null,
    depth: 0,
    name: "agent-1",
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: false, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: false, images: false },
    ...overrides,
  };
}

describe("agentStatus", () => {
  it("reports idle when nothing else is going on", () => {
    expect(agentStatus(makeAgent())).toEqual({ label: "Idle", tone: "idle" });
  });

  it("reflects activity states when lifecycle is live", () => {
    expect(agentStatus(makeAgent({ activity: "working" }))).toEqual({ label: "Working", tone: "working" });
    expect(agentStatus(makeAgent({ activity: "blocked" }))).toEqual({ label: "Blocked", tone: "blocked" });
  });

  it("gives lifecycle states priority over activity states", () => {
    expect(agentStatus(makeAgent({ lifecycle: "failed", activity: "working" }))).toEqual({ label: "Failed", tone: "failed" });
    expect(agentStatus(makeAgent({ lifecycle: "stopped", activity: "working" }))).toEqual({ label: "Stopped", tone: "stopped" });
    expect(agentStatus(makeAgent({ lifecycle: "inactive", activity: "blocked" }))).toEqual({ label: "Inactive", tone: "inactive" });
    expect(agentStatus(makeAgent({ lifecycle: "starting", activity: "working" }))).toEqual({ label: "Starting", tone: "starting" });
  });

  it("gives attention top priority over lifecycle and activity", () => {
    expect(agentStatus(makeAgent({ attention: "dialog", lifecycle: "failed", activity: "working" })))
      .toEqual({ label: "Needs response", tone: "attention" });
    expect(agentStatus(makeAgent({ attention: "question" }))).toEqual({ label: "Needs input", tone: "attention" });
    expect(agentStatus(makeAgent({ attention: "error" }))).toEqual({ label: "Needs attention", tone: "attention" });
  });
});
