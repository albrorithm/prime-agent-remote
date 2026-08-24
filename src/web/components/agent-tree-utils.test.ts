import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../protocol";
import {
  agentPriority,
  buildVisibleAgentDescendants,
  buildVisibleAgents,
  collectAgentDescendants,
  indexChildren,
} from "./agent-tree-utils";

function makeAgent(id: string, parentId: string | null, overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id,
    rootId: parentId ?? id,
    parentId,
    depth: 0,
    name: id,
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

const agents = [
  makeAgent("root", null),
  makeAgent("child", "root"),
  makeAgent("grandchild", "child"),
  makeAgent("great-grandchild", "grandchild"),
];

describe("agentPriority", () => {
  it("ranks attention above working above idle above inactive", () => {
    expect(agentPriority(makeAgent("a", null, { attention: "approval" }))).toBe(0);
    expect(agentPriority(makeAgent("a", null, { activity: "working" }))).toBe(1);
    expect(agentPriority(makeAgent("a", null))).toBe(2);
    expect(agentPriority(makeAgent("a", null, { lifecycle: "inactive" }))).toBe(3);
  });

  it("lets attention win even over a working agent", () => {
    const attention = makeAgent("a", null, { attention: "approval", activity: "working" });
    expect(agentPriority(attention)).toBe(0);
  });
});

describe("indexChildren", () => {
  it("groups by parentId, including a null-parent bucket for roots", () => {
    const byParent = indexChildren(agents);
    expect(byParent.get(null)?.map((item) => item.id)).toEqual(["root"]);
    expect(byParent.get("root")?.map((item) => item.id)).toEqual(["child"]);
    expect(byParent.get("child")?.map((item) => item.id)).toEqual(["grandchild"]);
  });

  it("sorts siblings by priority, tiebreaking on updatedAt descending", () => {
    const siblings = [
      makeAgent("idle-old", "root", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeAgent("working", "root", { activity: "working", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeAgent("idle-new", "root", { updatedAt: "2026-01-02T00:00:00.000Z" }),
      makeAgent("attention", "root", { attention: "approval", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeAgent("inactive", "root", { lifecycle: "inactive", updatedAt: "2026-01-03T00:00:00.000Z" }),
    ];
    const byParent = indexChildren(siblings);
    expect(byParent.get("root")?.map((item) => item.id)).toEqual([
      "attention",
      "working",
      "idle-new",
      "idle-old",
      "inactive",
    ]);
  });
});

describe("collectAgentDescendants", () => {
  it("collects all descendants without including unrelated agents", () => {
    const unrelated = makeAgent("unrelated", null);
    expect(collectAgentDescendants([...agents, unrelated], "root").map((item) => item.id)).toEqual([
      "child",
      "grandchild",
      "great-grandchild",
    ]);
  });

  it("stops safely when malformed relationships form a cycle", () => {
    const malformed = [makeAgent("root", "child"), makeAgent("child", "root")];
    expect(collectAgentDescendants(malformed, "root").map((item) => item.id)).toEqual(["child"]);
  });
});

describe("buildVisibleAgentDescendants", () => {
  it("shows direct children first and reveals only expanded branches", () => {
    expect(buildVisibleAgentDescendants(agents, "root", new Set()).map((row) => [row.agent.id, row.level])).toEqual([
      ["child", 1],
    ]);
    expect(
      buildVisibleAgentDescendants(agents, "root", new Set(["child", "grandchild"])).map((row) => [row.agent.id, row.level]),
    ).toEqual([
      ["child", 1],
      ["grandchild", 2],
      ["great-grandchild", 3],
    ]);
  });

  it("stops safely when malformed relationships form a cycle", () => {
    const malformed = [makeAgent("root", "child"), makeAgent("child", "root")];
    const visible = buildVisibleAgentDescendants(malformed, "root", new Set(["child"]));
    expect(visible.map((row) => row.agent.id)).toEqual(["child"]);
  });
});

describe("buildVisibleAgents", () => {
  it("orders a full forest depth-first, hiding collapsed subtrees", () => {
    expect(buildVisibleAgents(agents, new Set(agents.map((item) => item.id))).map((item) => item.id)).toEqual([
      "root",
      "child",
      "grandchild",
      "great-grandchild",
    ]);
    expect(buildVisibleAgents(agents, new Set(["root", "grandchild"])).map((item) => item.id)).toEqual(["root", "child"]);
  });

  it("still surfaces an agent whose parent is missing from the catalog", () => {
    const orphan = makeAgent("orphan", "ghost-parent");
    expect(buildVisibleAgents([...agents, orphan], new Set()).map((item) => item.id)).toContain("orphan");
  });

  it("guards cycles rather than recursing forever", () => {
    const cyclic = [makeAgent("a", "b"), makeAgent("b", "a")];
    expect(buildVisibleAgents(cyclic, new Set(["a", "b"])).map((item) => item.id).sort()).toEqual(["a", "b"]);
  });
});
