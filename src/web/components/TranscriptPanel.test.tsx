import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary, AttentionRequest, TranscriptMessage } from "../../protocol";
import type { useGateway } from "../gateway-store";
import { countUnseen, deriveAgentLineage, TranscriptEntry, TranscriptPanel } from "./TranscriptPanel";

type GatewayMockState = Pick<
  ReturnType<typeof useGateway>,
  "catalog" | "selectedAgent" | "selectedSnapshot" | "pendingMessages" | "selectAgent"
>;

const gatewayMock = vi.hoisted(() => ({ state: null as GatewayMockState | null }));

vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock.state }));
vi.mock("./MessageContent", () => ({ MessageContent: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("./Composer", () => ({ Composer: () => <div /> }));
vi.mock("./GoalStrip", () => ({ GoalStrip: () => <div /> }));
vi.mock("./AttentionCard", () => ({ AttentionCard: () => <div /> }));

function agent(id: string, parentId: string | null, depth: number): AgentSummary {
  return {
    id,
    parentId,
    depth,
    name: id,
    rootId: parentId ? "root" : id,
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: false, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: false, images: false },
  };
}

describe("agent lineage", () => {
  it("builds a root-to-selected ancestry path", () => {
    const agents = [agent("root", null, 0), agent("child", "root", 1), agent("leaf", "child", 2)];
    expect(deriveAgentLineage(agents, "leaf").map((item) => item.id)).toEqual(["root", "child", "leaf"]);
  });

  it("stops safely for malformed cycles and missing parents", () => {
    const cycle = [agent("a", "b", 1), agent("b", "a", 1)];
    expect(deriveAgentLineage(cycle, "a").map((item) => item.id)).toEqual(["b", "a"]);
    expect(deriveAgentLineage([agent("orphan", "missing", 1)], "orphan").map((item) => item.id)).toEqual(["orphan"]);
  });
});

describe("unseen counting", () => {
  it("counts only genuinely new messages", () => {
    expect(countUnseen(3, 5)).toBe(2);
  });

  it("never counts downward or on equal counts", () => {
    expect(countUnseen(5, 5)).toBe(0);
    expect(countUnseen(5, 3)).toBe(0);
  });

  it("accumulates across polls without phantom increments", () => {
    let previous = 0;
    let total = 0;
    for (const current of [1, 1, 2, 2, 7]) {
      total += countUnseen(previous, current);
      previous = current;
    }
    expect(total).toBe(7);
  });
});


describe("compact transcript entries", () => {
  const base: Omit<TranscriptMessage, "id" | "text" | "presentation"> = {
    role: "assistant",
    state: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("renders thinking and tool summaries as accessible one-line rows", () => {
    render(
      <>
        <TranscriptEntry
          agentName="Agent"
          message={{ ...base, id: "thinking", text: "Planning focused checks", presentation: { kind: "thinking" } }}
        />
        <TranscriptEntry
          agentName="Agent"
          message={{
            ...base,
            id: "tool",
            text: "npm test",
            presentation: { kind: "tool", label: "bash", status: "complete", meta: "↑ 2 ↓ 12 lines · 1.2s" },
          }}
        />
      </>,
    );

    const thinking = screen.getByLabelText("Thinking: Planning focused checks");
    expect(thinking).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(screen.getByText("Planning focused checks")).toMatchObject({ tagName: "STRONG" });
    expect(screen.getByLabelText("bash tool complete: npm test, ↑ 2 ↓ 12 lines · 1.2s")).toBeInTheDocument();
  });

  it("renders attachment metadata through the authenticated image route", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "image-message",
          role: "user",
          text: "See this",
          attachments: [{ id: "image_safe", type: "image", mimeType: "image/jpeg" }],
        }}
      />,
    );

    const image = screen.getByRole("img", { name: "Attached image 1" });
    expect(image).toHaveAttribute("src", "/api/v1/attachments/image_safe");
    expect(image).toHaveAttribute("loading", "lazy");
  });
});


describe("transcript attachment recovery", () => {
  it("offers a retry after a transient attachment failure", async () => {
    const user = userEvent.setup();
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          id: "retry-image",
          role: "user",
          state: "complete",
          createdAt: "2026-01-01T00:00:00.000Z",
          text: "See this",
          attachments: [{ id: "retry_safe", type: "image", mimeType: "image/jpeg" }],
        }}
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Attached image 1" }));
    expect(screen.getByRole("img", { name: "Attached image 1 is unavailable" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry image" }));
    expect(screen.getByRole("img", { name: "Attached image 1" }))
      .toHaveAttribute("src", "/api/v1/attachments/retry_safe?retry=1");
  });
});

describe("agent switching resets scroll state", () => {
  function messages(count: number, prefix: string): TranscriptMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      role: "assistant",
      text: `${prefix} message ${index}`,
      state: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
  }

  function gatewayState(
    agentId: string,
    snapshotMessages: TranscriptMessage[] | null,
    attention: AttentionRequest[] = [],
  ) {
    const selectedAgent = agent(agentId, null, 0);
    const snapshot: AgentSnapshot | null = snapshotMessages
      ? {
          revision: 1,
          agentId,
          messages: snapshotMessages,
          activity: [],
          attention,
        }
      : null;
    gatewayMock.state = {
      catalog: { revision: 0, agents: [selectedAgent] },
      selectedAgent,
      selectedSnapshot: snapshot,
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
  }

  function constrainScroll(element: HTMLElement) {
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
  }

  it("reserves horizontal touch gestures on the transcript scroller for the drawer", () => {
    gatewayState("agent-a", messages(1, "a"));
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(document.querySelector<HTMLElement>(".transcript-scroll")?.style.touchAction).toBe("pan-y");
  });

  it("scrolls to bottom and clears unseen when the selected agent changes", () => {
    gatewayState("agent-a", messages(3, "a"));
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    expect(scroller).not.toBeNull();

    // Simulate being scrolled away from the bottom of agent A's transcript.
    constrainScroll(scroller);
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    // New messages for agent A while not following produce an unseen badge.
    gatewayState("agent-a", messages(6, "a"));
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("button", { name: /Latest/ })).toBeInTheDocument();

    // Switching to agent B (with a longer transcript) must reset following.
    gatewayState("agent-b", messages(12, "b"));
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(screen.queryByRole("button", { name: /Latest/ })).not.toBeInTheDocument();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);

    // Follow mode sticks: further messages keep the view pinned to bottom.
    gatewayState("agent-b", messages(15, "b"));
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.queryByRole("button", { name: /Latest/ })).not.toBeInTheDocument();
  });

  it("does not vibrate for attention that already exists in a newly selected session", () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });

    gatewayState("agent-a", messages(1, "a"));
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(vibrate).not.toHaveBeenCalled();

    const existingAttention: AttentionRequest[] = [{
      id: "att-1",
      agentId: "agent-b",
      kind: "question",
      title: "Needs input",
      revision: 1,
      options: [{ id: "ok", label: "OK", tone: "default" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    // Selection changes before an uncached snapshot finishes loading.
    gatewayState("agent-b", null);
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(vibrate).not.toHaveBeenCalled();

    gatewayState("agent-b", messages(2, "b"), existingAttention);
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(vibrate).not.toHaveBeenCalled();

    gatewayState("agent-b", messages(2, "b"), [
      ...existingAttention,
      { ...existingAttention[0], id: "att-2", revision: 2 },
    ]);
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(vibrate).toHaveBeenCalledWith(30);

    Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined });
  });

  it("shows Latest when an existing streamed reply grows while scrolled up", () => {
    const streaming = messages(1, "stream").map((message) => ({ ...message, state: "streaming" as const }));
    gatewayState("agent-a", streaming);
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    constrainScroll(scroller);
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    gatewayState("agent-a", [{ ...streaming[0], text: `${streaming[0].text} more output` }]);
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("button", { name: /Latest/ })).toBeInTheDocument();
  });

  it("announces reply completion without announcing streaming token updates", () => {
    const streaming = { ...messages(1, "reply")[0], state: "streaming" as const };
    gatewayState("agent-a", [streaming]);
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    gatewayState("agent-a", [{ ...streaming, text: `${streaming.text} token` }]);
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(status).toHaveTextContent("");

    gatewayState("agent-a", [{ ...streaming, text: `${streaming.text} done`, state: "complete" }]);
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(status).toHaveTextContent("agent-a finished replying.");
  });

  it("keeps follow mode pinned for pending messages and late image loads", () => {
    gatewayState("agent-a", []);
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    const scroller = document.querySelector(".transcript-scroll") as HTMLElement;
    constrainScroll(scroller);
    scroller.scrollTop = 600;

    gatewayMock.state = {
      ...gatewayMock.state!,
      pendingMessages: [{
        id: "pending-1",
        text: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        knownUserMessageIds: [],
        attachments: [{ mimeType: "image/jpeg", previewUrl: "blob:pending", ownsPreviewUrl: false }],
      }],
    };
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    fireEvent.load(screen.getByRole("img", { name: "Attached image 1" }));
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(screen.queryByRole("button", { name: /Latest/ })).not.toBeInTheDocument();
  });

  it("uses lifecycle-first status labels in the transcript header", () => {
    const failed = { ...agent("failed", null, 0), lifecycle: "failed" as const };
    gatewayMock.state = {
      catalog: { revision: 0, agents: [failed] },
      selectedAgent: failed,
      selectedSnapshot: { revision: 1, agentId: failed.id, messages: [], activity: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });

});
