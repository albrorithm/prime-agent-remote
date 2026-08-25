import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary, SessionDashboard as SessionDashboardData } from "../../protocol";
import { SessionDashboard } from "./SessionDashboard";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.current }));

function agent(id: string): AgentSummary {
  return {
    id,
    rootId: id,
    parentId: null,
    depth: 0,
    name: "Root agent",
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: false, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: false, images: false },
  };
}

function snapshotWith(dashboard?: SessionDashboardData): AgentSnapshot {
  return { revision: 1, agentId: "root", messages: [], attention: [], ...(dashboard ? { dashboard } : {}) };
}

const fullDashboard: SessionDashboardData = {
  status: "responding",
  recap: "Investigating the flaky upload test",
  needsInput: true,
  contextUsage: { tokens: 45000, contextWindow: 200000, percent: 22.5 },
  children: [
    {
      id: "child-1",
      agentId: "agent-child-1",
      name: "Investigate flaky test",
      status: "running",
      toolName: "ipython",
      durationMs: 92_000,
      answerPreview: "Reproduced the failure locally",
      toolUseCount: 4,
      tokenCount: 12_345,
    },
  ],
  refines: [
    {
      id: "refine-1",
      status: "complete",
      summary: "Added a retry skill for flaky network calls",
      scope: "local",
      createdAt: "2026-01-01T09:15:00.000Z",
    },
  ],
};

describe("SessionDashboard", () => {
  it("renders every section when the dashboard is fully populated", () => {
    gatewayMock.current = {
      selectedAgent: agent("root"),
      selectedSnapshot: snapshotWith(fullDashboard),
      selectAgent: vi.fn(),
    };
    render(<SessionDashboard />);

    expect(screen.getByText("Responding")).toBeInTheDocument();
    expect(screen.getByText("Investigating the flaky upload test")).toBeInTheDocument();
    expect(screen.getByText("May need input")).toBeInTheDocument();
    expect(screen.getByText("Context used")).toBeInTheDocument();
    expect(screen.getByText("23%")).toBeInTheDocument();
    expect(screen.getByText("Investigate flaky test")).toBeInTheDocument();
    expect(screen.getByText(/4 tools/)).toBeInTheDocument();
    expect(screen.getByText(/12,345 tokens/)).toBeInTheDocument();
    expect(screen.getByText("Added a retry skill for flaky network calls")).toBeInTheDocument();
  });

  it("gives the needs-input badge advisory copy, never a queue or approval framing", () => {
    gatewayMock.current = {
      selectedAgent: agent("root"),
      selectedSnapshot: snapshotWith({ ...fullDashboard, needsInput: true }),
      selectAgent: vi.fn(),
    };
    render(<SessionDashboard />);

    const badge = screen.getByRole("note");
    expect(badge).toHaveTextContent("May need input");
    expect(badge).toHaveTextContent(/guess/i);
    expect(badge).toHaveTextContent(/not a task queue/i);
    expect(badge.textContent).not.toMatch(/approve|approval|pending review/i);
  });

  it("does not render a needs-input badge when the daemon has not flagged it", () => {
    gatewayMock.current = {
      selectedAgent: agent("root"),
      selectedSnapshot: snapshotWith({ ...fullDashboard, needsInput: false }),
      selectAgent: vi.fn(),
    };
    render(<SessionDashboard />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("navigates to a child session when its row is tapped", async () => {
    const user = userEvent.setup();
    const selectAgent = vi.fn().mockResolvedValue(undefined);
    const onNavigate = vi.fn();
    gatewayMock.current = {
      selectedAgent: agent("root"),
      selectedSnapshot: snapshotWith(fullDashboard),
      selectAgent,
    };
    render(<SessionDashboard onNavigate={onNavigate} />);

    await user.click(screen.getByRole("button", { name: /Investigate flaky test/ }));
    expect(selectAgent).toHaveBeenCalledWith("agent-child-1");
    expect(onNavigate).toHaveBeenCalled();
  });

  it("renders a non-interactive row for a child with no linked agent session", () => {
    gatewayMock.current = {
      selectedAgent: agent("root"),
      selectedSnapshot: snapshotWith({
        ...fullDashboard,
        children: [{ ...fullDashboard.children[0], agentId: undefined }],
      }),
      selectAgent: vi.fn(),
    };
    render(<SessionDashboard />);
    expect(screen.queryByRole("button", { name: /Investigate flaky test/ })).not.toBeInTheDocument();
    expect(screen.getByText("Investigate flaky test")).toBeInTheDocument();
  });

  it("shows a loading state while the snapshot has not arrived", () => {
    gatewayMock.current = { selectedAgent: agent("root"), selectedSnapshot: null, selectAgent: vi.fn() };
    render(<SessionDashboard />);
    expect(screen.getByText(/Loading dashboard/)).toBeInTheDocument();
  });

  it("shows an honest empty state when the snapshot has no dashboard", () => {
    gatewayMock.current = { selectedAgent: agent("root"), selectedSnapshot: snapshotWith(undefined), selectAgent: vi.fn() };
    render(<SessionDashboard />);
    expect(screen.getByText("No dashboard data for this session.")).toBeInTheDocument();
  });

  describe("refine history timestamps", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2030-06-15T18:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders the refine's own createdAt, not the current time", () => {
      gatewayMock.current = {
        selectedAgent: agent("root"),
        selectedSnapshot: snapshotWith(fullDashboard),
        selectAgent: vi.fn(),
      };
      render(<SessionDashboard />);

      const time = document.querySelector("time");
      expect(time).not.toBeNull();
      expect(time).toHaveAttribute("dateTime", "2026-01-01T09:15:00.000Z");
    });
  });
});
