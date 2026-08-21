import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { AgentTree, buildVisibleAgents } from "./AgentTree";

function makeAgent(id: string, parentId: string | null, depth: number): AgentSummary {
  return {
    id,
    rootId: "root",
    parentId,
    depth,
    name: id,
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

const agents = [
  makeAgent("root", null, 0),
  makeAgent("child", "root", 1),
  makeAgent("grandchild", "child", 2),
  makeAgent("great-grandchild", "grandchild", 3),
];

describe("AgentTree", () => {
  it("renders the selected agent's full ancestry with ARIA levels", async () => {
    render(<AgentTree agents={agents} selectedId="great-grandchild" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(4));
    const items = screen.getAllByRole("treeitem");
    expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "2", "3", "4"]);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it("hides descendants of collapsed nodes instead of flattening them", async () => {
    const onSelect = vi.fn();
    render(<AgentTree agents={agents} selectedId="root" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Collapse root" }));
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(1));
    expect(screen.getByRole("treeitem", { name: /root/i })).toBeDefined();
  });

  it("expands root sessions that appear after mount", () => {
    const { rerender } = render(<AgentTree agents={[makeAgent("root", null, 0)]} selectedId="root" onSelect={vi.fn()} />);
    rerender(<AgentTree agents={[makeAgent("root", null, 0), makeAgent("new-root", null, 0), makeAgent("new-child", "new-root", 1)]} selectedId="root" onSelect={vi.fn()} />);
    expect(screen.getByRole("treeitem", { name: /new-child/i })).toBeDefined();
  });

  it("supports tree arrow navigation and selection", async () => {
    const onSelect = vi.fn();
    render(<AgentTree agents={agents} selectedId="root" onSelect={onSelect} />);
    const root = screen.getByRole("treeitem", { name: /root/i });
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    const child = screen.getAllByRole("treeitem").find((item) => item.getAttribute("aria-level") === "2");
    await waitFor(() => expect(child).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("child");
  });

  it("guards cycles rather than recursing forever", () => {
    const cyclic = [makeAgent("a", "b", 1), makeAgent("b", "a", 1)];
    expect(buildVisibleAgents(cyclic, new Set(["a", "b"])).map((item) => item.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps collapsed subtrees hidden across catalog updates", () => {
    expect(buildVisibleAgents(agents, new Set(agents.map((item) => item.id))).map((item) => item.id)).toEqual([
      "root",
      "child",
      "grandchild",
      "great-grandchild",
    ]);
    expect(buildVisibleAgents(agents, new Set(["root", "grandchild"])).map((item) => item.id)).toEqual(["root", "child"]);
  });
});
