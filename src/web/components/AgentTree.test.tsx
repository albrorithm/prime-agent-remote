import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { AgentTree, directoryLeaf } from "./AgentTree";

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
    capabilities: { send: true, abort: false, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: false, images: false },
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

  /* Position and keyboard descent used to come from a local index built in
     arrival order while the rows were rendered in priority order. A screen
     reader then read the tree back to front, and ArrowRight skipped past the
     first visible child — whenever the daemon changed an agent's activity or
     attention, which is precisely the sort key. */
  it("reports position and descends in the order the rows are actually rendered", async () => {
    const reordered = [
      makeAgent("root", null, 0),
      // Arrives first, sorts second: idle loses to working.
      makeAgent("idle-child", "root", 1),
      { ...makeAgent("working-child", "root", 1), activity: "working" as const },
    ];
    const onSelect = vi.fn();
    render(<AgentTree agents={reordered} selectedId="root" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(3));

    const items = screen.getAllByRole("treeitem");
    const rendered = items.map((item) => item.textContent);
    expect(rendered[1]).toContain("working-child");
    expect(rendered[2]).toContain("idle-child");
    // What each row announces has to match where it actually is.
    expect(items.slice(1).map((item) => item.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
    expect(items.slice(1).map((item) => item.getAttribute("aria-setsize"))).toEqual(["2", "2"]);

    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("treeitem")[1]));
    expect(document.activeElement?.textContent).toContain("working-child");
  });

  it("hides descendants of collapsed nodes instead of flattening them", async () => {
    const onSelect = vi.fn();
    render(<AgentTree agents={agents} selectedId="root" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Collapse root" }));
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(1));
    expect(screen.getByRole("treeitem", { name: /root/i })).toBeDefined();
  });

  it("keeps a root collapsed when catalog data updates", async () => {
    const { rerender } = render(<AgentTree agents={agents} selectedId="root" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse root" }));
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(1));

    const updated = agents.map((item) => ({ ...item, updatedAt: "2026-01-01T00:01:00.000Z" }));
    rerender(<AgentTree agents={updated} selectedId="root" onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Expand root" })).toBeDefined();
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

  it("stops a working agent without selecting it", async () => {
    const user = userEvent.setup();
    const working = makeAgent("root", null, 0);
    working.activity = "working";
    working.capabilities = { ...working.capabilities, abort: true };
    const onSelect = vi.fn();
    let finishAbort: (() => void) | undefined;
    const onAbort = vi.fn(() => new Promise<void>((resolve) => { finishAbort = resolve; }));
    render(<AgentTree agents={[working]} selectedId={null} onSelect={onSelect} onAbort={onAbort} />);

    await user.click(screen.getByRole("button", { name: "Stop root" }));

    expect(onAbort).toHaveBeenCalledWith("root");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stopping root" })).toBeDisabled();

    await act(async () => { finishAbort?.(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop root" })).toBeEnabled());
  });

  it("derives the directory leaf for row subtitles", () => {
    expect(directoryLeaf("/workspace/mobile-ui")).toBe("mobile-ui");
    expect(directoryLeaf("/")).toBeNull();
    expect(directoryLeaf(undefined)).toBeNull();
  });
  it("always leaves one visible result in the roving tab order after filtering", () => {
    const { rerender } = render(<AgentTree agents={agents} selectedId="root" onSelect={vi.fn()} />);
    rerender(<AgentTree agents={[agents[2], agents[3]]} selectedId="root" onSelect={vi.fn()} />);
    const visible = screen.getAllByRole("treeitem");
    expect(visible.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(visible.find((item) => item.tabIndex === 0)).toHaveTextContent("grandchild");
  });

  it("moves focus when a live catalog update removes the focused row", async () => {
    const { rerender } = render(<AgentTree agents={agents} selectedId={null} onSelect={vi.fn()} />);
    const child = screen.getByRole("treeitem", { name: /^child/i });
    child.focus();
    expect(child).toHaveFocus();
    rerender(<AgentTree agents={[agents[0], agents[2]]} selectedId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /^root/i })).toHaveFocus());
    expect(screen.getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it("labels lifecycle states before idle activity", () => {
    const failed = { ...makeAgent("failed", null, 0), lifecycle: "failed" as const };
    const starting = { ...makeAgent("starting", null, 0), lifecycle: "starting" as const };
    render(<AgentTree agents={[failed, starting]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("treeitem", { name: /failed.*Failed/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /starting.*Starting/i })).toBeInTheDocument();
  });


  it("offers a manage entry point only for sessions the backend says are manageable", async () => {
    const onManage = vi.fn();
    const manageable = { ...makeAgent("root", null, 0), capabilities: { ...makeAgent("root", null, 0).capabilities, rename: true } };
    render(<AgentTree agents={[manageable, makeAgent("child", "root", 1)]} selectedId="root" onSelect={vi.fn()} onManage={onManage} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(2));

    // "child" advertises no management capability, so it gets no button.
    expect(screen.queryByRole("button", { name: "Manage child" })).toBeNull();

    // Managing must not also open the session the row points at.
    fireEvent.click(screen.getByRole("button", { name: "Manage root" }));
    expect(onManage).toHaveBeenCalledWith("root");
  });

  it("shows no manage entry point at all without a handler", async () => {
    const manageable = { ...makeAgent("root", null, 0), capabilities: { ...makeAgent("root", null, 0).capabilities, rename: true } };
    render(<AgentTree agents={[manageable]} selectedId="root" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Manage root" })).toBeNull();
  });
});
