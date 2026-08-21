import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../protocol";
import { countUnseen, deriveAgentLineage } from "./TranscriptPanel";

function agent(id: string, parentId: string | null, depth: number): AgentSummary {
  return {
    id,
    parentId,
    depth,
    name: id,
    rootId: parentId ? "root" : id,
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: false, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: false },
  };
}

describe("agent lineage", () => {
  it("builds a root-to-selected ancestry path", () => {
    const agents = [agent("root", null, 0), agent("child", "root", 1), agent("leaf", "child", 2)];
    expect(deriveAgentLineage(agents, "leaf").map((item) => item.id)).toEqual(["root", "child", "leaf"]);
  });

  it("stops safely for malformed cycles and missing parents", () => {
    const cycle = [agent("a", "b", 1), agent("b", "a", 1)];
    expect(deriveAgentLineage(cycle, "a").map((item) => item.id)).toEqual(["b", "a"]);
    expect(deriveAgentLineage([agent("orphan", "missing", 1)], "orphan").map((item) => item.id)).toEqual(["orphan"]);
  });
});

describe("unseen counting", () => {
  it("counts only genuinely new messages", () => {
    expect(countUnseen(3, 5)).toBe(2);
  });

  it("never counts downward or on equal counts", () => {
    expect(countUnseen(5, 5)).toBe(0);
    expect(countUnseen(5, 3)).toBe(0);
  });

  it("accumulates across polls without phantom increments", () => {
    let previous = 0;
    let total = 0;
    for (const current of [1, 1, 2, 2, 7]) {
      total += countUnseen(previous, current);
      previous = current;
    }
    expect(total).toBe(7);
  });
});
