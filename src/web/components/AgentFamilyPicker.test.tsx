import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import {
  AgentFamilyPicker,
  buildVisibleAgentDescendants,
  collectAgentDescendants,
} from "./AgentFamilyPicker";

function agent(id: string, parentId: string | null, depth: number, overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id,
    rootId: parentId ? "root" : id,
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
    ...overrides,
  };
}

const agents = [
  agent("root", null, 0),
  agent("research", "root", 1, { activity: "working", childCount: 1 }),
  agent("review", "root", 1),
  agent("example", "research", 2, { unreadCount: 2 }),
  agent("unrelated", null, 0),
  agent("other-child", "unrelated", 1),
];

describe("agent family indexing", () => {
  it("collects all descendants without including unrelated agents", () => {
    expect(collectAgentDescendants(agents, "root").map((item) => item.id))
      .toEqual(["research", "example", "review"]);
  });

  it("shows direct children first and reveals only expanded branches", () => {
    expect(buildVisibleAgentDescendants(agents, "root", new Set()).map((row) => [row.agent.id, row.level]))
      .toEqual([["research", 1], ["review", 1]]);
    expect(buildVisibleAgentDescendants(agents, "root", new Set(["research"])).map((row) => [row.agent.id, row.level]))
      .toEqual([["research", 1], ["example", 2], ["review", 1]]);
  });

  it("stops safely when malformed relationships form a cycle", () => {
    const malformed = [agent("root", "child", 0), agent("child", "root", 1)];
    expect(collectAgentDescendants(malformed, "root").map((item) => item.id)).toEqual(["child"]);
  });
});

describe("forward subagent breadcrumb", () => {
  it("opens a tree, expands without navigating, and selects a descendant", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <>
        <h1 id="transcript-heading" tabIndex={-1}>root</h1>
        <AgentFamilyPicker agents={agents} selectedAgent={agents[0]} onSelect={onSelect} />
      </>,
    );

    const trigger = screen.getByRole("button", { name: "Open 3 subagents of root, 1 working" });
    expect(trigger).toHaveTextContent("3subagents");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Subagents" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /research/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /review/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /example/ })).not.toBeInTheDocument();

    const disclosure = screen.getByRole("button", { name: "Expand research subagents" });
    await user.click(disclosure);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("treeitem", { name: /example/ })).toHaveAttribute("aria-level", "2");

    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("treeitem", { name: /example/ })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("treeitem", { name: /example/ })).toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: /example/ }));
    expect(onSelect).toHaveBeenCalledWith("example");
    expect(screen.queryByRole("dialog", { name: "Subagents" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "root" })).toHaveFocus();
  });

  it("closes with Escape and restores focus to the forward breadcrumb", async () => {
    const user = userEvent.setup();
    render(<AgentFamilyPicker agents={agents} selectedAgent={agents[0]} onSelect={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Open 3 subagents/ });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Subagents" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not expose cycle edges as expandable children", async () => {
    const user = userEvent.setup();
    const malformed = [agent("root", "child", 0), agent("child", "root", 1)];
    render(<AgentFamilyPicker agents={malformed} selectedAgent={malformed[0]} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Open 1 subagent/ }));
    const child = screen.getByRole("treeitem", { name: "child, Idle" });
    expect(child).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByRole("button", { name: /Expand child/ })).not.toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(child).toHaveAttribute("tabindex", "0");
  });

  it("moves roving focus when a live catalog update removes the focused row", async () => {
    const user = userEvent.setup();
    const view = render(<AgentFamilyPicker agents={agents} selectedAgent={agents[0]} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Open 3 subagents/ }));
    expect(screen.getByRole("treeitem", { name: /research/ })).toHaveFocus();

    const remaining = agents.filter((item) => item.id !== "research" && item.id !== "example");
    view.rerender(<AgentFamilyPicker agents={remaining} selectedAgent={agents[0]} onSelect={() => {}} />);
    const review = screen.getByRole("treeitem", { name: /review/ });
    expect(review).toHaveAttribute("tabindex", "0");
    await waitFor(() => expect(review).toHaveFocus());
  });

  it("restores trigger focus when the scrim dismisses the picker", async () => {
    const user = userEvent.setup();
    render(<AgentFamilyPicker agents={agents} selectedAgent={agents[0]} onSelect={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Open 3 subagents/ });
    await user.click(trigger);
    await user.click(document.querySelector<HTMLElement>(".family-picker-scrim")!);
    expect(trigger).toHaveFocus();
  });

  it("renders no forward control for a leaf agent", () => {
    render(<AgentFamilyPicker agents={agents} selectedAgent={agents[2]} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /subagents of review/ })).not.toBeInTheDocument();
  });
});
