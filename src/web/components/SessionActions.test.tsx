import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { hasSessionActions, SessionActions } from "./SessionActions";

const rename = vi.fn();

vi.mock("../gateway-store", () => ({
  useGateway: () => ({ rename }),
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
    expect(hasSessionActions(makeAgent({ capabilities: { rename: false } as AgentSummary["capabilities"] }))).toBe(false);
  });

  it("is true once the backend says the session can be renamed", () => {
    expect(hasSessionActions(makeAgent())).toBe(true);
  });
});

describe("SessionActions", () => {
  it("offers nothing to rename when the backend refuses the capability", () => {
    render(
      <SessionActions
        agent={makeAgent({ capabilities: { rename: false } as AgentSummary["capabilities"] })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename session" })).toBeNull();
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
});
