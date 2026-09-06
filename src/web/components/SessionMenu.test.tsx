import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { SessionMenu } from "./SessionMenu";

const gatewayMock = vi.hoisted(() => ({
  rename: vi.fn(),
  stop: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

beforeEach(() => {
  gatewayMock.rename = vi.fn().mockResolvedValue(undefined);
  gatewayMock.stop = vi.fn().mockResolvedValue(undefined);
  gatewayMock.deleteSession = vi.fn().mockResolvedValue(undefined);
});

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "agent-1",
    rootId: "agent-1",
    parentId: null,
    depth: 0,
    name: "Original name",
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: false, resume: false, rename: true, stop: true, deactivate: false, delete: true, respond: false, images: false },
    ...overrides,
  };
}

/** The menu positions itself inside `.agents-panel`, beside the control that opened it. */
function open(agent = makeAgent(), props: Partial<Parameters<typeof SessionMenu>[0]> = {}) {
  const onClose = vi.fn();
  const onOpenControls = vi.fn();
  const onTogglePin = vi.fn();
  const onToggleArchive = vi.fn();
  const panel = document.createElement("section");
  panel.className = "agents-panel";
  const anchor = document.createElement("button");
  anchor.setAttribute("aria-label", `Manage ${agent.name}`);
  // React clears whatever it renders into, so the row control gets a sibling
  // mount point rather than sharing the panel with the menu directly.
  const mount = document.createElement("div");
  panel.append(anchor, mount);
  document.body.append(panel);
  const view = render(
    <SessionMenu
      agent={agent}
      anchor={anchor}
      onClose={onClose}
      onOpenControls={onOpenControls}
      pinned={false}
      archived={false}
      onTogglePin={onTogglePin}
      onToggleArchive={onToggleArchive}
      {...props}
    />,
    { container: mount },
  );
  return { view, anchor, onClose, onOpenControls, onTogglePin, onToggleArchive };
}

describe("SessionMenu", () => {
  it("lists the row's options, first item focused, and offers organizing only to a root", () => {
    open();
    const menu = screen.getByRole("menu", { name: "Original name options" });
    expect(menu).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Pin", "Archive", "Rename…", "Goal, autonomy, heartbeat…", "End session", "Delete…",
    ]);
    expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus();

    open(makeAgent({ id: "child", parentId: "agent-1", capabilities: { ...makeAgent().capabilities, stop: false, delete: false } }));
    // A subagent's place in the list is its root's, and the session controls
    // act on roots, so it gets the one thing the backend says it can do.
    const items = screen.getAllByRole("menu")[1]!;
    expect(items.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
    expect(items).toHaveTextContent("Rename…");
  });

  it("pins and archives in one tap and closes, giving focus back to the row control", async () => {
    const user = userEvent.setup();
    const { anchor, onClose, onTogglePin } = open();
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onTogglePin).toHaveBeenCalledWith("agent-1");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(anchor).toHaveFocus());
  });

  it("renames in place: the field replaces the menu, Enter sends the trimmed name, and success closes", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Session name" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Original name");
    // Unchanged is not a rename.
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();

    await user.clear(field);
    await user.type(field, "  New name  {Enter}");
    await waitFor(() => expect(gatewayMock.rename).toHaveBeenCalledWith("agent-1", "New name"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the typed name when the rename fails, and Cancel goes back to the menu", async () => {
    gatewayMock.rename = vi.fn().mockRejectedValue(new Error("refused"));
    const user = userEvent.setup();
    const { onClose } = open();
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const field = screen.getByRole("textbox", { name: "Session name" });
    await user.clear(field);
    await user.type(field, "Another");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(gatewayMock.rename).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveValue("Another");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes a second, named step to delete, in place", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(gatewayMock.deleteSession).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete Original name" })).toHaveTextContent("Delete Original name and its transcript");

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(gatewayMock.deleteSession).toHaveBeenCalledWith("agent-1", "Original name"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("disarms rather than staying primed when the delete is refused", async () => {
    gatewayMock.deleteSession = vi.fn().mockRejectedValue(new Error("refused"));
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(gatewayMock.deleteSession).toHaveBeenCalled());
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
  });

  it("ends the session from the menu and stays open if that fails", async () => {
    const user = userEvent.setup();
    const first = open();
    await user.click(screen.getByRole("menuitem", { name: "End session" }));
    await waitFor(() => expect(gatewayMock.stop).toHaveBeenCalledWith("agent-1"));
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    first.view.unmount();

    gatewayMock.stop = vi.fn().mockRejectedValue(new Error("refused"));
    const second = open();
    await user.click(screen.getByRole("menuitem", { name: "End session" }));
    await waitFor(() => expect(gatewayMock.stop).toHaveBeenCalled());
    expect(second.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "End session" })).toBeEnabled();
  });

  it("hands the controls that need a screen over to the full view, for a live root only", async () => {
    const user = userEvent.setup();
    const { view, onOpenControls, onClose } = open();
    await user.click(screen.getByRole("menuitem", { name: "Goal, autonomy, heartbeat…" }));
    expect(onOpenControls).toHaveBeenCalledWith("agent-1");
    expect(onClose).toHaveBeenCalled();
    view.unmount();

    open(makeAgent({ lifecycle: "inactive" }));
    expect(screen.queryByRole("menuitem", { name: "Goal, autonomy, heartbeat…" })).not.toBeInTheDocument();
  });

  it("closes on Escape, on a tap elsewhere, and on the list scrolling; arrows walk the items", async () => {
    const user = userEvent.setup();
    const escape = open();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Delete…" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(escape.onClose).toHaveBeenCalledTimes(1);
    escape.view.unmount();

    const outside = open();
    await user.pointer({ keys: "[MouseLeft]", target: document.body });
    expect(outside.onClose).toHaveBeenCalledTimes(1);
    outside.view.unmount();

    const scrolled = open();
    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(scrolled.onClose).toHaveBeenCalledTimes(1);
  });
});
