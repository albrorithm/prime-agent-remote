import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import { ActivityPanel } from "./ActivityPanel";

const gatewayMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.current }));

function agent(id: string, parentId: string | null, lifecycle: AgentSummary["lifecycle"]): AgentSummary {
  return {
    id,
    rootId: parentId ? "root" : id,
    parentId,
    depth: parentId ? 1 : 0,
    name: id,
    lifecycle,
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: false, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: false, images: false },
  };
}

describe("ActivityPanel", () => {
  it("uses lifecycle-first labels for subagents", () => {
    const root = agent("root", null, "live");
    const failed = agent("failed child", root.id, "failed");
    const starting = agent("starting child", root.id, "starting");
    gatewayMock.current = {
      selectedAgent: root,
      selectedSnapshot: { revision: 1, agentId: root.id, messages: [], activity: [], attention: [] },
      catalog: { revision: 1, agents: [root, failed, starting] },
      selectAgent: vi.fn(),
    };
    render(<ActivityPanel />);
    expect(screen.getByRole("button", { name: /failed child.*Failed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /starting child.*Starting/i })).toBeInTheDocument();
  });
});
