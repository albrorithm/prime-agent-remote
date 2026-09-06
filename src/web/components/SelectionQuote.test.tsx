import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { clearPendingQuotes, pendingQuotesSnapshot } from "../quote";
import { SelectionQuote } from "./SelectionQuote";

const gatewayMock = vi.hoisted(() => ({ state: { catalog: { revision: 1, agents: [] as AgentSummary[] }, selectedAgent: null as AgentSummary | null } }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.state }));

function agent(id: string, name: string, parentId: string | null = null): AgentSummary {
  return {
    id, rootId: parentId ?? id, parentId, depth: parentId ? 1 : 0, name, lifecycle: "live", activity: "idle", attention: null,
    unreadCount: 0, childCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: true, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: true, images: false },
  };
}

/** jsdom lays nothing out, so the selection's box is given a size by hand. */
function selectText(node: Node, from: number, to: number) {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  range.getBoundingClientRect = () => ({ top: 300, left: 100, width: 120, height: 20, bottom: 320, right: 220, x: 100, y: 300, toJSON: () => ({}) });
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => { document.dispatchEvent(new Event("selectionchange")); });
  act(() => { vi.runOnlyPendingTimers(); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  clearPendingQuotes();
  document.body.innerHTML = "";
});
afterEach(() => vi.useRealTimers());

describe("SelectionQuote", () => {
  it("follows a selection inside a message and quotes it into this session's composer", () => {
    const self = agent("child", "Reviewer", "root");
    gatewayMock.state = { catalog: { revision: 1, agents: [agent("root", "Planner"), self] }, selectedAgent: self };
    const { container } = render(
      <div>
        <article className="message assistant"><p>The build fails on arm64 only.</p></article>
        <SelectionQuote />
      </div>,
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();

    const text = container.querySelector("article p")!.firstChild!;
    selectText(text, 0, 15);
    expect(screen.getByRole("toolbar", { name: "Quote the selection" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(pendingQuotesSnapshot().get("child")).toEqual({ source: "Reviewer", text: "The build fails" });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("offers the parent from a subagent, names the user's own words as such, and ignores selections elsewhere", () => {
    const self = agent("child", "Reviewer", "root");
    gatewayMock.state = { catalog: { revision: 1, agents: [agent("root", "Planner"), self] }, selectedAgent: self };
    const { container } = render(
      <div>
        <article className="message user"><p>Please check arm64.</p></article>
        <p className="elsewhere">Not a message.</p>
        <SelectionQuote />
      </div>,
    );
    selectText(container.querySelector("article p")!.firstChild!, 0, 6);
    fireEvent.click(screen.getByRole("button", { name: "Quote into Planner's message" }));
    expect(pendingQuotesSnapshot().get("root")).toEqual({ source: "You", text: "Please" });

    selectText(container.querySelector(".elsewhere")!.firstChild!, 0, 3);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("says when a long selection was cut, the way a whole-message quote does", () => {
    const self = agent("root", "Planner");
    gatewayMock.state = { catalog: { revision: 1, agents: [self] }, selectedAgent: self };
    const long = "x".repeat(4_500);
    const { container } = render(
      <div>
        <article className="message assistant"><p>{long}</p></article>
        <SelectionQuote />
      </div>,
    );
    selectText(container.querySelector("article p")!.firstChild!, 0, long.length);
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    const quoted = pendingQuotesSnapshot().get("root")!.text;
    expect(quoted).toHaveLength(4_000);
    expect(quoted.endsWith("…")).toBe(true);
  });
});
