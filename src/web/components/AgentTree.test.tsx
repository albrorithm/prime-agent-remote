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
  it("renders arbitrary nesting with ARIA levels", () => {
    render(<AgentTree agents={agents} selectedId="root" onSelect={vi.fn()} />);
    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "2", "3", "4"]);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
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
});
