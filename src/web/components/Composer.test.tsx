import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary } from "../../protocol";
import { Composer } from "./Composer";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.current }));

const agent: AgentSummary = {
  id: "agent-1",
  rootId: "agent-1",
  parentId: null,
  depth: 0,
  name: "Agent",
  lifecycle: "live",
  activity: "idle",
  attention: null,
  unreadCount: 0,
  childCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  capabilities: { send: true, abort: true, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: true },
};
const snapshot: AgentSnapshot = { revision: 1, agentId: agent.id, messages: [], activity: [], attention: [] };

beforeEach(() => {
  gatewayMock.current = {
    selectedAgent: agent,
    selectedSnapshot: snapshot,
    send: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Composer", () => {
  it("sends trimmed text and clears the draft only after success", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "  hello  ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("hello"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps a failed draft available for retry", async () => {
    gatewayMock.current.send = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "try again");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("try again");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  });

  it("sends on Enter and keeps Shift+Enter for a newline", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const input = screen.getByRole("textbox", { name: "Message Agent" });
    await user.type(input, "first line");
    await user.keyboard("{Shift>}{Enter}{/Shift}second line");
    expect(input).toHaveValue("first line\nsecond line");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(gatewayMock.current.send).toHaveBeenCalledWith("first line\nsecond line"));
  });

  it("starts a slash command from the extensible composer menu", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await user.click(screen.getByRole("button", { name: "Composer options" }));
    await user.click(screen.getByRole("menuitem", { name: /Slash command/ }));
    expect(screen.getByRole("textbox", { name: "Message Agent" })).toHaveValue("/");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("prevents duplicate stop requests while one is pending", async () => {
    let finish!: () => void;
    gatewayMock.current.selectedSnapshot = {
      ...snapshot,
      messages: [{ id: "stream", role: "assistant", text: "", state: "streaming", createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    gatewayMock.current.abort = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<Composer />);
    const stop = screen.getByRole("button", { name: "Stop agent" });
    await user.click(stop);
    await user.click(stop);
    expect(gatewayMock.current.abort).toHaveBeenCalledTimes(1);
    expect(stop).toBeDisabled();
    finish();
    await waitFor(() => expect(stop).toBeEnabled());
  });

  it("persists drafts to session storage for reload recovery", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await user.type(screen.getByRole("textbox", { name: "Message Agent" }), "survives reload");
    expect(sessionStorage.getItem("prime-web-drafts")).toContain("survives reload");
  });
});
