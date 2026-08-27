import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { hasSessionActions, SessionActions } from "./SessionActions";

const rename = vi.fn();
const stop = vi.fn();
const deleteSession = vi.fn();

vi.mock("../gateway-store", () => ({
  useGateway: () => ({ deleteSession, rename, stop }),
}));

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
    ...overrides,
    capabilities: {
      send: true,
      abort: false,
      resume: false,
      rename: true,
      stop: false,
      deactivate: false,
      delete: false,
      respond: false,
      images: false,
      ...overrides.capabilities,
    },
  };
}

describe("hasSessionActions", () => {
  it("is false for a session with nothing to manage", () => {
    expect(hasSessionActions(makeAgent({
      capabilities: { rename: false, stop: false, delete: false } as AgentSummary["capabilities"],
    }))).toBe(false);
  });

  it("is true for a session that can only be stopped", () => {
    expect(hasSessionActions(makeAgent({ capabilities: { rename: false, stop: true } as AgentSummary["capabilities"] }))).toBe(true);
  });

  it("is true once the backend says the session can be renamed", () => {
    expect(hasSessionActions(makeAgent())).toBe(true);
  });
});

describe("SessionActions", () => {
  it("offers nothing to rename when the backend refuses the capability", () => {
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { rename: false, stop: false, delete: false } as AgentSummary["capabilities"] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
  });

  it("offers to end a session only when the backend says it has one to end", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stop.mockReset().mockResolvedValue(undefined);
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { rename: true, stop: true } as AgentSummary["capabilities"] })}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "End session" }));

    await waitFor(() => expect(stop).toHaveBeenCalledWith("agent-1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open when ending the session fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stop.mockReset().mockRejectedValue(new Error("Action is not allowed"));
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { rename: true, stop: true } as AgentSummary["capabilities"] })}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "End session" }));

    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "End session" })).toBeEnabled();
  });

  it("starts from the current name and stays disabled until it actually changes", async () => {
    const user = userEvent.setup();
    render(<SessionActions agent={makeAgent()} onClose={vi.fn()} />);

    const field = screen.getByLabelText("Session name");
    expect(field).toHaveValue("Original name");
    const submit = screen.getByRole("button", { name: "Rename session" });
    expect(submit).toBeDisabled();

    // Whitespace either side of the same name is not a rename.
    await user.type(field, "  ");
    expect(submit).toBeDisabled();

    await user.clear(field);
    expect(submit).toBeDisabled();
  });

  it("sends the trimmed name and closes on success", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rename.mockReset().mockResolvedValue(undefined);
    render(<SessionActions agent={makeAgent()} onClose={onClose} />);

    const field = screen.getByLabelText("Session name");
    await user.clear(field);
    await user.type(field, "  A better name  ");
    await user.click(screen.getByRole("button", { name: "Rename session" }));

    await waitFor(() => expect(rename).toHaveBeenCalledWith("agent-1", "A better name"));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the typed name on screen when the rename fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rename.mockReset().mockRejectedValue(new Error("Action is not allowed"));
    render(<SessionActions agent={makeAgent()} onClose={onClose} />);

    const field = screen.getByLabelText("Session name");
    await user.clear(field);
    await user.type(field, "Attempted name");
    await user.click(screen.getByRole("button", { name: "Rename session" }));

    await waitFor(() => expect(rename).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Session name")).toHaveValue("Attempted name");
  });

  it("takes two deliberate taps to delete, and offers a way back from the first", async () => {
    const user = userEvent.setup();
    deleteSession.mockReset().mockResolvedValue(undefined);
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { delete: true } as AgentSummary["capabilities"] })}
        onClose={vi.fn()}
      />,
    );

    // The first tap only reveals the confirmation — a single tap anywhere in
    // this view must not destroy anything.
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete permanently…" }));
    expect(deleteSession).not.toHaveBeenCalled();
    // The session about to go is named in the confirmation itself, which is
    // what typing it was for. Scoped to the section: the drawer header carries
    // the same name, and finding that one would prove nothing.
    const deleteSection = screen.getByRole("region", { name: "Delete this session" });
    expect(within(deleteSection).getByText("Original name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("deletes with the name the catalog holds", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    deleteSession.mockReset().mockResolvedValue(undefined);
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { delete: true } as AgentSummary["capabilities"] })}
        onClose={onClose}
      />,
    );

    // The gateway checks the name it is sent against the session's current one,
    // so the browser must send what its catalog says, never a typed string.
    await user.click(screen.getByRole("button", { name: "Delete permanently…" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("agent-1", "Original name"));
    expect(onClose).toHaveBeenCalled();
  });

  it("disarms when the delete is refused", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    deleteSession.mockReset().mockRejectedValue(new Error("That is not this session's name"));
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { delete: true } as AgentSummary["capabilities"] })}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete permanently…" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    // Nothing was deleted, so it goes back to needing both taps rather than
    // sitting primed under the user's thumb.
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete permanently…" })).toBeEnabled();
  });
});
