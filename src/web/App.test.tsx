import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary } from "../protocol";
import { App } from "./App";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./gateway-store", () => ({ useGateway: () => gatewayMock.current }));

function agent(id: string, parentId: string | null, depth: number): AgentSummary {
  return {
    id,
    rootId: parentId ? "root" : id,
    parentId,
    depth,
    name: id === "root" ? "Root agent" : "Child agent",
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: id === "root" ? 1 : 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: true, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: true, images: true },
  };
}

const rootAgent = agent("root", null, 0);
const childAgent = agent("child", "root", 1);
const snapshot: AgentSnapshot = { revision: 1, agentId: "root", messages: [], activity: [], attention: [] };

beforeEach(() => {
  gatewayMock.current = {
    authRequired: false,
    connection: "live",
    backend: "prime",
    error: null,
    catalog: { revision: 1, agents: [rootAgent, childAgent] },
    selectedAgentId: "root",
    selectedAgent: rootAgent,
    selectedSnapshot: snapshot,
    pendingMessages: [],
    pending: {},
    selectAgent: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
  };
});

describe("mobile shell navigation", () => {
  it("opens the session drawer and returns to chat after selecting another agent", async () => {
    const user = userEvent.setup();
    render(<App />);
    const shell = screen.getByRole("main");
    expect(shell).toHaveAttribute("data-sessions-open", "false");

    const openButton = screen.getByRole("button", { name: "Open sessions" });
    const nativeSwitch = openButton.parentElement!.querySelector<HTMLInputElement>(".switch-haptic-input")!;
    expect(nativeSwitch).toHaveAttribute("type", "checkbox");
    expect(nativeSwitch).toHaveAttribute("switch", "");
    expect(nativeSwitch).toHaveAttribute("aria-hidden", "true");
    await user.click(nativeSwitch);
    expect(shell).toHaveAttribute("data-sessions-open", "true");

    await user.click(screen.getByRole("treeitem", { name: /Child agent/ }));
    expect(gatewayMock.current.selectAgent).toHaveBeenCalledWith("child");
    expect(shell).toHaveAttribute("data-sessions-open", "false");
  });

  it("opens the session drawer when a swipe commits", () => {
    render(<App />);
    const shell = screen.getByRole("main");

    const dispatchPointer = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        pointerType: { value: "touch" },
        isPrimary: { value: true },
        clientX: { value: clientX },
        clientY: { value: clientY },
      });
      fireEvent(shell, event);
    };
    dispatchPointer("pointerdown", 8, 160);
    dispatchPointer("pointermove", 170, 162);
    dispatchPointer("pointerup", 170, 162);

    expect(shell).toHaveAttribute("data-sessions-open", "true");
  });

  it("opens activity from the compact header and closes it without a footer tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    const shell = screen.getByRole("main");
    await user.click(screen.getByRole("button", { name: /Open activity/ }));
    expect(shell).toHaveAttribute("data-activity-open", "true");
    await user.click(screen.getByRole("button", { name: "Close activity" }));
    expect(shell).toHaveAttribute("data-activity-open", "false");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("stops a working session from the drawer without navigating", async () => {
    const user = userEvent.setup();
    const workingRoot = { ...rootAgent, activity: "working" as const };
    gatewayMock.current = {
      ...gatewayMock.current,
      catalog: { revision: 2, agents: [workingRoot, childAgent] },
      selectedAgent: workingRoot,
    };
    render(<App />);
    const shell = screen.getByRole("main");
    await user.click(screen.getByRole("button", { name: "Open sessions" }));

    await user.click(screen.getByRole("button", { name: "Stop Root agent" }));

    expect(gatewayMock.current.abort).toHaveBeenCalledWith("root");
    expect(gatewayMock.current.selectAgent).not.toHaveBeenCalled();
    expect(shell).toHaveAttribute("data-sessions-open", "true");
  });
});
