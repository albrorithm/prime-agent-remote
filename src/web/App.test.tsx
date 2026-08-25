import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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
const snapshot: AgentSnapshot = { revision: 1, agentId: "root", messages: [], attention: [] };

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

  it("opens the session drawer from across the content view when a swipe commits", () => {
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
    dispatchPointer("pointerdown", 180, 160);
    dispatchPointer("pointermove", 342, 162);
    dispatchPointer("pointerup", 342, 162);

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

  it("does not open the drawer for a mostly vertical content gesture", () => {
    render(<App />);
    const shell = screen.getByRole("main");
    const dispatchPointer = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 8 }, pointerType: { value: "touch" }, isPrimary: { value: true },
        clientX: { value: clientX }, clientY: { value: clientY },
      });
      fireEvent(shell, event);
    };
    dispatchPointer("pointerdown", 100, 160);
    dispatchPointer("pointermove", 112, 240);
    dispatchPointer("pointerup", 112, 240);
    expect(shell).toHaveAttribute("data-sessions-open", "false");
  });

  it("contains mobile modal focus and hides global controls above the drawer", async () => {
    gatewayMock.current = { ...gatewayMock.current, backend: "demo", error: "Request failed" };
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Open sessions" }));
    expect(screen.getByRole("dialog", { name: "Sessions" })).toHaveAttribute("aria-modal", "true");
    const stage = document.querySelector(".conversation-stage")!;
    const globalUi = document.querySelector(".shell-global-ui")!;
    expect(stage).toHaveAttribute("inert");
    expect(stage).toHaveAttribute("aria-hidden", "true");
    expect(globalUi).toHaveAttribute("inert");
    expect(globalUi).toHaveAttribute("aria-hidden", "true");
    expect(globalUi).toHaveClass("is-modal-hidden");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss hint" })).not.toBeInTheDocument();
    expect(globalUi).toContainElement(screen.getByText("Demo"));

    // Even programmatic focus outside the modal is recovered on the next Tab.
    const hiddenRetry = document.querySelector<HTMLButtonElement>(".connection-banner button")!;
    hiddenRetry.focus();
    fireEvent.keyDown(hiddenRetry, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close sessions" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Close sessions" }));
    expect(screen.queryByRole("dialog", { name: "Sessions" })).not.toBeInTheDocument();
    expect(stage).not.toHaveAttribute("inert");
    expect(globalUi).not.toHaveAttribute("inert");
    expect(globalUi).not.toHaveClass("is-modal-hidden");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("restores focus to the connected header trigger when the opener disappears", async () => {
    gatewayMock.current = {
      ...gatewayMock.current,
      catalog: { revision: 1, agents: [rootAgent] },
      selectedAgentId: null,
      selectedAgent: null,
      selectedSnapshot: null,
    };
    let refresh: (() => void) | null = null;
    function Harness() {
      const [, setVersion] = useState(0);
      refresh = () => setVersion((version) => version + 1);
      return <App />;
    }
    gatewayMock.current.selectAgent = vi.fn(async (id: string) => {
      gatewayMock.current = {
        ...gatewayMock.current,
        selectedAgentId: id,
        selectedAgent: rootAgent,
        selectedSnapshot: snapshot,
      };
      refresh?.();
    });

    const user = userEvent.setup();
    render(<Harness />);
    const centralOpener = screen.getByText("Open sessions").closest("button")!;
    await user.click(centralOpener);
    await user.click(screen.getByRole("treeitem", { name: /Root agent/ }));

    expect(centralOpener.isConnected).toBe(false);
    expect(screen.getByRole("button", { name: "Open sessions" })).toHaveFocus();
  });

  it("keeps persistent desktop sidebars non-modal and disables drawer gestures", () => {
    const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(min-width: 1100px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    try {
      render(<App />);
      const shell = screen.getByRole("main");
      const stage = document.querySelector(".conversation-stage")!;
      expect(screen.queryByRole("dialog", { name: "Sessions" })).not.toBeInTheDocument();
      expect(stage).not.toHaveAttribute("inert");
      expect(document.querySelector(".shell-global-ui")).not.toHaveAttribute("inert");

      const pointer = (type: string, clientX: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          pointerId: { value: 9 }, pointerType: { value: "touch" }, isPrimary: { value: true },
          clientX: { value: clientX }, clientY: { value: 160 },
        });
        fireEvent(shell, event);
      };
      pointer("pointerdown", 5);
      pointer("pointermove", 180);
      pointer("pointerup", 180);
      expect(shell).toHaveAttribute("data-sessions-open", "false");
    } finally {
      if (original) Object.defineProperty(window, "matchMedia", original);
      else delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
    }
  });

});
