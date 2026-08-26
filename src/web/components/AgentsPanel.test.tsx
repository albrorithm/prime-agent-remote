import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attentionAgentCount, type AgentSummary } from "../../protocol";
import { SettingsProvider } from "../settings";
import { AgentsPanel } from "./AgentsPanel";

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "agent-1",
    rootId: "agent-1",
    parentId: null,
    depth: 0,
    name: "agent-1",
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

const root = makeAgent({ id: "root", rootId: "root", name: "release-planning", activity: "working" });
const child = makeAgent({ id: "child", rootId: "root", parentId: "root", depth: 1, name: "db-migration", attention: "dialog" });
const other = makeAgent({ id: "other", rootId: "other", name: "docs-cleanup" });

const gatewayMock = vi.hoisted(() => ({
  abort: vi.fn(),
  attentionCount: 0,
  catalog: { revision: 1, agents: [] as AgentSummary[] },
  selectedAgentId: null as string | null,
  selectAgent: vi.fn(),
  backend: "demo" as "demo" | "prime" | null,
  signOut: vi.fn(),
}));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

beforeEach(() => {
  gatewayMock.abort = vi.fn();
  gatewayMock.catalog = { revision: 1, agents: [root, child, other] };
  gatewayMock.attentionCount = attentionAgentCount(gatewayMock.catalog.agents);
  gatewayMock.selectedAgentId = null;
  gatewayMock.selectAgent = vi.fn().mockResolvedValue(undefined);
  gatewayMock.backend = "demo";
  gatewayMock.signOut = vi.fn().mockResolvedValue(undefined);
});

function renderPanel(props: Parameters<typeof AgentsPanel>[0] = {}) {
  return render(<SettingsProvider><AgentsPanel {...props} /></SettingsProvider>);
}

describe("AgentsPanel", () => {
  it("shows attention and working counts across all agents", () => {
    render(<AgentsPanel />);
    expect(screen.getByText("1 attention")).toBeInTheDocument();
    expect(screen.getByText("1 working")).toBeInTheDocument();
  });

  it("filters sessions by search while keeping ancestors of a match", async () => {
    const user = userEvent.setup();
    render(<AgentsPanel />);

    await user.type(screen.getByPlaceholderText("Search sessions"), "db-migration");

    expect(screen.getByRole("treeitem", { name: /release-planning/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /db-migration/i })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /docs-cleanup/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when no session matches the search", async () => {
    const user = userEvent.setup();
    render(<AgentsPanel />);

    await user.type(screen.getByPlaceholderText("Search sessions"), "nonexistent-agent-name");

    expect(screen.getByText("No sessions match that search.")).toBeInTheDocument();
  });

  it("navigates to a selected agent and calls onNavigate", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<AgentsPanel onNavigate={onNavigate} />);

    await user.click(screen.getByRole("treeitem", { name: /docs-cleanup/i }));

    expect(gatewayMock.selectAgent).toHaveBeenCalledWith("other");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AgentsPanel onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close sessions" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the close button when onClose is not provided", () => {
    render(<AgentsPanel />);
    expect(screen.queryByRole("button", { name: "Close sessions" })).not.toBeInTheDocument();
  });

  it("replaces the mobile FAB with a header button on persistent desktop widths", () => {
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
      render(<AgentsPanel />);
      expect(screen.getByRole("button", { name: "Start a new session" })).not.toHaveClass("new-session-fab");
      expect(document.querySelector(".new-session-fab")).not.toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(window, "matchMedia", original);
      else delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
    }
  });

  it("shows a single close affordance in the new-session flow, not two", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AgentsPanel onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Start a new session" }));

    expect(screen.queryByRole("button", { name: "Close sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close new session" })).toBeInTheDocument();
  });

  it("opens settings from the drawer header and takes over the panel", async () => {
    const user = userEvent.setup();
    renderPanel({ visible: true });

    await user.click(screen.getByRole("button", { name: "Open settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // The sub-view replaces the list and its header, exactly as new-session does.
    expect(screen.queryByPlaceholderText("Search sessions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close sessions" })).not.toBeInTheDocument();
  });

  it("returns to the session list when settings is closed", async () => {
    const user = userEvent.setup();
    renderPanel({ visible: true });

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(screen.getByPlaceholderText("Search sessions")).toBeInTheDocument();
  });

  it("leaves settings when the drawer closes, so reopening lands on the sessions list", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SettingsProvider><AgentsPanel visible /></SettingsProvider>);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();

    rerender(<SettingsProvider><AgentsPanel visible={false} /></SettingsProvider>);
    rerender(<SettingsProvider><AgentsPanel visible /></SettingsProvider>);

    expect(screen.getByPlaceholderText("Search sessions")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
  });
});
