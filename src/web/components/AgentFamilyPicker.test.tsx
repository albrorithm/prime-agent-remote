import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { AgentFamilyPicker } from "./AgentFamilyPicker";

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

    // The pill shows the count alone; the noun lives in the accessible name
    // this query already matches on, so the header keeps its width for the
    // agent's own name.
    const trigger = screen.getByRole("button", { name: "Open 3 subagents of root, 1 working" });
    expect(trigger).toHaveTextContent("3");
    expect(trigger).not.toHaveTextContent("subagents");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Subagents" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "research, Working, 1 direct subagent" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "review, Idle" })).toBeInTheDocument();
    expect(screen.getByText("research")).toHaveAttribute("title", "research");
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

    await user.click(trigger);
    expect(screen.getByRole("treeitem", { name: /research/ })).toHaveFocus();
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

  it("closes on outside interaction without stealing focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AgentFamilyPicker agents={agents} selectedAgent={agents[0]} onSelect={() => {}} />
        <button type="button">Outside control</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: /Open 3 subagents/ }));
    const outside = screen.getByRole("button", { name: "Outside control" });
    await user.click(outside);
    expect(screen.queryByRole("dialog", { name: "Subagents" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("renders no forward control for an only-child leaf with no siblings", () => {
    render(<AgentFamilyPicker agents={agents} selectedAgent={agents[3]} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /Open .* of example/ })).not.toBeInTheDocument();
  });
});

describe("sibling breadcrumb for leaf agents", () => {
  it("shows the parent's tree in Siblings mode when the leaf has siblings", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <>
        <h1 id="transcript-heading" tabIndex={-1}>review</h1>
        <AgentFamilyPicker agents={agents} selectedAgent={agents[2]} onSelect={onSelect} />
      </>,
    );

    const trigger = screen.getByRole("button", { name: "Open 1 sibling of review, 1 working" });
    expect(trigger).toHaveTextContent("1");
    expect(trigger).not.toHaveTextContent("sibling");
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: "Siblings" })).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Siblings of review" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "research, Working, 1 direct subagent" })).toBeInTheDocument();
    const currentRow = screen.getByRole("treeitem", { name: "review, Idle, current" });
    expect(currentRow).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByRole("treeitem", { name: /research/ }));
    expect(onSelect).toHaveBeenCalledWith("research");
    expect(screen.getByRole("heading", { name: "review" })).toHaveFocus();
  });
});
