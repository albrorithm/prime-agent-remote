import { fireEvent, render as renderBare, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary, AttentionRequest, TranscriptMessage } from "../../protocol";
import type { useGateway } from "../gateway-store";
import { SETTINGS_KEY, SettingsProvider } from "../settings";
import { authorLineIds, cwdBasename, deriveAgentLineage, TranscriptEntry, TranscriptPanel } from "./TranscriptPanel";

type GatewayMockState = Pick<
  ReturnType<typeof useGateway>,
  "catalog" | "selectedAgent" | "selectedSnapshot" | "pendingMessages" | "selectAgent"
> & Partial<Pick<ReturnType<typeof useGateway>, "transcriptErrors" | "retryTranscript">>;

const gatewayMock = vi.hoisted(() => ({ state: null as GatewayMockState | null }));

// The panel reads the app-wide attention count from the store rather than
// recomputing it, so the mock derives it from the same catalog with the same
// shared selector the provider uses.
vi.mock("../gateway-store", async () => {
  const { attentionAgentCount } = await import("../../protocol");
  return {
    useGateway: () => gatewayMock.state
      && {
        // Defaulted rather than omitted: the real store always carries these,
        // and a mock that leaves them undefined is kinder than the thing it
        // stands in for. A test that wants the failed state sets them.
        transcriptErrors: {},
        retryTranscript: async () => {},
        ...gatewayMock.state,
        attentionCount: attentionAgentCount(gatewayMock.state.catalog.agents),
      },
  };
});
vi.mock("./MessageContent", () => ({
  MessageContent: ({ text }: { text: string }) => <p>{text}</p>,
  MemoizedCodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));
vi.mock("./Composer", () => ({ Composer: () => <div /> }));
vi.mock("./GoalStrip", () => ({ GoalStrip: () => <div /> }));
vi.mock("./AttentionCard", () => ({ AttentionCard: () => <div /> }));

// Transcript components read useSettings(); main.tsx mounts the provider above them.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: SettingsProvider });

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

  it("expands a thinking row to its full text when presentation.full is bounded and populated", async () => {
    const user = userEvent.setup();
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "thinking-full",
          text: "Planning focused checks",
          presentation: { kind: "thinking", full: "Planning focused checks across the auth module, the session store, and the retry ladder before touching any code." },
        }}
      />,
    );

    expect(screen.getByText(/retry ladder/)).not.toBeVisible();
    await user.click(screen.getByText("Planning focused checks"));
    expect(screen.getByText(/retry ladder/)).toBeVisible();
  });

  it("does not add an expand affordance when there is no distinct full text", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{ ...base, id: "thinking-plain", text: "Planning focused checks", presentation: { kind: "thinking", full: "Planning focused checks" } }}
      />,
    );
    expect(document.querySelector("details.thinking-disclosure")).not.toBeInTheDocument();
  });

  it("dispatches python rows to the expandable cell row", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "cell",
          text: "run_checks()",
          presentation: { kind: "python", lang: "python", status: "complete", preview: "run_checks()", meta: "420ms", code: "run_checks()", durationMs: 420 },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "python cell complete: run_checks(), 420ms" })).toHaveAttribute("aria-expanded", "false");
  });

  it("dispatches refine rows to the refine renderer", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "refine",
          role: "system",
          text: "Tightened prompt guidance",
          presentation: { kind: "refine", status: "complete", summary: "Tightened prompt guidance", scope: "local" },
        }}
      />,
    );
    expect(screen.getByRole("group", { name: "Refine complete, Tightened prompt guidance, local scope" })).toBeInTheDocument();
  });

  // The label is the summary and the body is behind a disclosure. Laying both
  // on the row's one nowrap line gave the label — which does not shrink — the
  // whole width and wrapped the body one letter at a time down the right edge.
  it("puts a notice body behind its label", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "notice",
          role: "system",
          text: "Compacted the last 41 exchanges.",
          presentation: { kind: "notice", label: "Context compacted", tone: "info" },
        }}
      />,
    );
    const summary = screen.getByText("Context compacted");
    expect(summary.closest("summary")).toBeInTheDocument();
    expect(screen.getByText("Compacted the last 41 exchanges.")).toBeInTheDocument();
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  // A body that only repeats the label is not detail, so it gets no disclosure.
  it("renders a notice with nothing to add as a plain line", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "notice-flat",
          role: "system",
          text: "Compaction skipped",
          presentation: { kind: "notice", label: "Compaction skipped", tone: "info" },
        }}
      />,
    );
    const notice = screen.getByRole("note", { name: "Compaction skipped" });
    expect(notice).toBeInTheDocument();
    expect(notice.closest("details")).toBeNull();
  });

  it("names the sender of an inter-agent message and collapses its body", async () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "agent-message",
          role: "system",
          text: "FINDINGS\n\nThe custom branch handles exactly **four** customTypes.",
          presentation: { kind: "agent-message", sender: "agent-msg-recon", relationship: "child" },
        }}
      />,
    );
    const summary = screen.getByText("Message from subagent agent-msg-recon");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    // The body goes through MessageContent — Markdown, not a raw dump. This
    // file stubs that component, so the real rendering is checked by eye in
    // .ui-harness (case `work-density`); what matters here is that the body
    // reaches it at all instead of being dropped or inlined into the summary.
    const body = disclosure?.querySelector(".agent-message-body");
    expect(body?.textContent).toContain("The custom branch handles exactly");
    await userEvent.click(summary);
    expect(disclosure).toHaveAttribute("open");
  });

  it("says when an inter-agent message came from the parent", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "agent-message-parent",
          role: "system",
          text: "Check the drawers on iPad.",
          presentation: { kind: "agent-message", sender: "root-session", relationship: "parent" },
        }}
      />,
    );
    expect(screen.getByText("Message from root-session, its parent")).toBeInTheDocument();
  });

  it("renders error rows with their label and full text", () => {
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "error",
          state: "failed",
          text: "The response failed before producing an answer.",
          presentation: { kind: "error", label: "Turn failed" },
        }}
      />,
    );
    const error = screen.getByRole("note", { name: "Turn failed: The response failed before producing an answer." });
    expect(within(error).getByText("The response failed before producing an answer.")).toBeInTheDocument();
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

  it("opens attachments in an in-app viewer with close and download controls", async () => {
    const user = userEvent.setup();
    render(
      <TranscriptEntry
        agentName="Agent"
        message={{
          ...base,
          id: "viewer-image",
          role: "user",
          text: "Open this",
          attachments: [{ id: "viewer_safe", type: "image", mimeType: "image/jpeg" }],
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "View attached image 1" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Attached image 1" });
    expect(within(dialog).getByRole("img", { name: "Attached image 1 full size" }))
      .toHaveAttribute("src", "/api/v1/attachments/viewer_safe");
    expect(within(dialog).getByRole("link", { name: "Download" }))
      .toHaveAttribute("href", "/api/v1/attachments/viewer_safe");
    expect(within(dialog).getByRole("link", { name: "Download" }))
      .toHaveAttribute("download", "attached-image-1.jpg");
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the author-row clock only while the timestamps setting is on", () => {
    const message: TranscriptMessage = { ...base, id: "answer", text: "Done" };
    const shown = renderBare(
      <SettingsProvider><TranscriptEntry agentName="Agent" message={message} /></SettingsProvider>,
    );
    expect(shown.container.querySelector("time")).toHaveAttribute("dateTime", base.createdAt);
    shown.unmount();

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ timestamps: false }));
    const hidden = renderBare(
      <SettingsProvider><TranscriptEntry agentName="Agent" message={message} /></SettingsProvider>,
    );
    expect(hidden.container.querySelector("time")).toBeNull();
    expect(hidden.getByText("Agent")).toBeInTheDocument();
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

  it("badges the sessions trigger from the shared count, ignoring dead sessions", () => {
    const waiting = { ...agent("waiting", null, 0), attention: "dialog" as const };
    const alsoWaiting = { ...agent("also-waiting", null, 0), attention: "question" as const };
    const abandoned = { ...agent("abandoned", null, 0), attention: "error" as const, lifecycle: "stopped" as const };
    gatewayMock.state = {
      catalog: { revision: 0, agents: [waiting, alsoWaiting, abandoned] },
      selectedAgent: waiting,
      selectedSnapshot: { revision: 1, agentId: waiting.id, messages: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(screen.getByRole("button", { name: "Open sessions, 2 need attention" })).toBeInTheDocument();
    expect(document.querySelector(".sessions-trigger .icon-badge")).toHaveTextContent("2");
  });

  it("uses lifecycle-first status labels in the transcript header", () => {
    const failed = { ...agent("failed", null, 0), lifecycle: "failed" as const };
    gatewayMock.state = {
      catalog: { revision: 0, agents: [failed] },
      selectedAgent: failed,
      selectedSnapshot: { revision: 1, agentId: failed.id, messages: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });

  it("suppresses the working status chip when the subagent pill already shows a descendant working", () => {
    const workingRoot = { ...agent("root", null, 0), activity: "working" as const };
    const workingChild = { ...agent("worker", "root", 1), activity: "working" as const };
    gatewayMock.state = {
      catalog: { revision: 0, agents: [workingRoot, workingChild] },
      selectedAgent: workingRoot,
      selectedSnapshot: { revision: 1, agentId: workingRoot.id, messages: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.queryByRole("img", { name: "Working" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open 1 subagent of root, 1 working" })).toBeInTheDocument();
  });

  it("still shows the working status chip when no descendant is working", () => {
    const workingRoot = { ...agent("root", null, 0), activity: "working" as const };
    const idleChild = agent("child", "root", 1);
    gatewayMock.state = {
      catalog: { revision: 0, agents: [workingRoot, idleChild] },
      selectedAgent: workingRoot,
      selectedSnapshot: { revision: 1, agentId: workingRoot.id, messages: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("img", { name: "Working" })).toBeInTheDocument();
  });

  it("only masks the lineage row once it actually overflows, and keeps the current agent in view", () => {
    gatewayState("agent-a", messages(1, "a"));
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    const lineageRow = document.querySelector<HTMLElement>(".agent-lineage")!;
    expect(lineageRow).not.toHaveAttribute("data-overflowing");

    Object.defineProperty(lineageRow, "scrollWidth", { configurable: true, value: 640 });
    Object.defineProperty(lineageRow, "clientWidth", { configurable: true, value: 240 });
    gatewayState("agent-b", messages(1, "b"));
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(lineageRow).toHaveAttribute("data-overflowing", "true");
    expect(lineageRow.scrollLeft).toBe(640);
  });

  it("collapses a deep lineage behind an ancestor menu, keeping the root and immediate parent legible", async () => {
    const user = userEvent.setup();
    const chain = [
      agent("root", null, 0),
      agent("a", "root", 1),
      agent("b", "a", 2),
      agent("c", "b", 3),
      agent("leaf", "c", 4),
    ];
    gatewayMock.state = {
      catalog: { revision: 0, agents: chain },
      selectedAgent: chain[4],
      selectedSnapshot: { revision: 1, agentId: "leaf", messages: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(screen.getByRole("button", { name: "root" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "c" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "leaf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "a" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "b" })).not.toBeInTheDocument();

    const ancestorTrigger = screen.getByRole("button", { name: "Open 2 hidden ancestors" });
    await user.click(ancestorTrigger);
    expect(screen.getByRole("dialog", { name: "Ancestors" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "a" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "b" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "a" }));
    expect(gatewayMock.state!.selectAgent).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("dialog", { name: "Ancestors" })).not.toBeInTheDocument();
  });

});

describe("session title", () => {
  it("reduces a working directory to its last segment", () => {
    expect(cwdBasename("/srv/projects/mobile-ui")).toBe("mobile-ui");
    expect(cwdBasename("/srv/projects/mobile-ui/")).toBe("mobile-ui");
    expect(cwdBasename("/")).toBe("/");
    expect(cwdBasename("")).toBe("");
    expect(cwdBasename(undefined)).toBe("");
  });

  function setSelected(selectedAgent: AgentSummary, agents: AgentSummary[]) {
    gatewayMock.state = {
      catalog: { revision: 0, agents },
      selectedAgent,
      selectedSnapshot: { revision: 1, agentId: selectedAgent.id, messages: [], attention: [] },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
  }

  it("titles a root agent by session name over its working directory", () => {
    const root = { ...agent("Nightly sweep", null, 0), cwd: "/srv/projects/mobile-ui" };
    setSelected(root, [root]);
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nightly sweep");
    expect(view.container.querySelector(".lineage-cwd")).toHaveTextContent("mobile-ui");
  });

  it("leaves a subagent titled by agent name with no directory line", () => {
    const root = { ...agent("Nightly sweep", null, 0), cwd: "/srv/projects/mobile-ui" };
    const child = { ...agent("api-reviewer", "Nightly sweep", 1), cwd: "/srv/projects/mobile-ui" };
    setSelected(child, [root, child]);
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("api-reviewer");
    expect(view.container.querySelector(".lineage-cwd")).toBeNull();
  });

  it("falls back to the bare title when a root reports no directory", () => {
    const root = agent("Nightly sweep", null, 0);
    setSelected(root, [root]);
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nightly sweep");
    expect(view.container.querySelector(".lineage-title")).toBeNull();
  });
});

describe("authorLineIds", () => {
  function msg(id: string, role: TranscriptMessage["role"], presentation?: TranscriptMessage["presentation"]): TranscriptMessage {
    return { id, role, text: id, state: "complete", createdAt: "2026-01-01T00:00:00.000Z", ...(presentation ? { presentation } : {}) };
  }

  it("attributes the first message and every change of speaker", () => {
    const ids = authorLineIds([msg("u1", "user"), msg("a1", "assistant"), msg("a2", "assistant"), msg("u2", "user")]);
    expect([...ids]).toEqual(["u1", "a1", "u2"]);
  });

  it("does not let timeline rows restate the speaker mid-answer", () => {
    const ids = authorLineIds([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("t1", "system", { kind: "tool", label: "bash", status: "complete" }),
      msg("think", "assistant", { kind: "thinking" }),
      msg("a2", "assistant"),
    ]);
    expect([...ids]).toEqual(["u1", "a1"]);
  });

  it("returns nothing for a transcript of pure timeline rows", () => {
    expect(authorLineIds([msg("t1", "system", { kind: "tool", label: "bash", status: "complete" })]).size).toBe(0);
    expect(authorLineIds([]).size).toBe(0);
  });
});

describe("turn grouping in the panel", () => {
  function turnMessages(): TranscriptMessage[] {
    return [
      {
        id: "legacy",
        role: "system",
        text: "Session resumed from an earlier save.",
        state: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "u1",
        role: "user",
        text: "Refactor the trimming helper.",
        state: "complete",
        createdAt: "2026-01-01T00:01:00.000Z",
        turnId: "u1",
      },
      {
        id: "tool1",
        role: "system",
        text: "npm test",
        state: "complete",
        createdAt: "2026-01-01T00:02:00.000Z",
        turnId: "u1",
        presentation: { kind: "tool", label: "bash", status: "complete", meta: "4.2s" },
      },
      {
        id: "a1",
        role: "assistant",
        text: "Refactored the helper and the suite passes.",
        state: "complete",
        createdAt: "2026-01-01T00:03:00.000Z",
        turnId: "u1",
      },
    ];
  }

  function setState(messages: TranscriptMessage[], recap?: string) {
    const selectedAgent = agent("agent-a", null, 0);
    gatewayMock.state = {
      catalog: { revision: 0, agents: [selectedAgent] },
      selectedAgent,
      selectedSnapshot: {
        revision: 1,
        agentId: "agent-a",
        messages,
        attention: [],
        ...(recap !== undefined
          ? { dashboard: { status: "idle" as const, recap, needsInput: false, children: [], refines: [] } }
          : {}),
      },
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
    };
  }

  it("groups consecutive turnId rows and leaves legacy rows flat", () => {
    setState(turnMessages());
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    const list = view.container.querySelector(".message-list")!;
    const group = list.querySelector(":scope > .turn-group")!;
    expect(group).not.toBeNull();
    expect(group.querySelector("details.turn-work")).not.toBeNull();
    // The one work row is a bash tool call with no python duration, yet the turn
    // spans 00:01 to 00:03 — the summary reports that wall clock, not 0.
    expect(screen.getByText("1 step · 2m")).toBeInTheDocument();

    // The legacy row renders as a direct sibling, outside any group.
    const legacy = screen.getByText("Session resumed from an earlier save.").closest("article")!;
    expect(legacy.closest(".turn-group")).toBeNull();
    expect(legacy.parentElement).toBe(list);
  });

  it("uses the dashboard recap for the latest settled turn's collapsed summary", () => {
    setState(turnMessages(), "Refactored the trimming helper end to end");
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(screen.getByText("Refactored the trimming helper end to end")).toBeInTheDocument();
    // The one work row is a bash tool call with no python duration, yet the turn
    // spans 00:01 to 00:03 — the summary reports that wall clock, not 0.
    expect(screen.getByText("1 step · 2m")).toBeInTheDocument();
  });

  it("search mode renders a flat list and clearing the search restores grouping", async () => {
    const user = userEvent.setup();
    setState(turnMessages());
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);
    expect(view.container.querySelector(".turn-group")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Search transcript" }));
    await user.type(screen.getByRole("textbox", { name: "Search this transcript" }), "helper");

    expect(view.container.querySelector(".turn-group")).toBeNull();
    expect(view.container.querySelector("details.turn-work")).toBeNull();
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close search" }));
    expect(view.container.querySelector(".turn-group")).not.toBeNull();
    expect(view.container.querySelector("details.turn-work")).not.toBeNull();
  });

  it("clears search state when the selected agent changes", async () => {
    const user = userEvent.setup();
    setState(turnMessages());
    const view = render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Search transcript" }));
    await user.type(screen.getByRole("textbox", { name: "Search this transcript" }), "helper");
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    const otherAgent = agent("agent-b", null, 0);
    gatewayMock.state = {
      ...gatewayMock.state!,
      selectedAgent: otherAgent,
      selectedSnapshot: { revision: 1, agentId: "agent-b", messages: [], attention: [] },
    };
    view.rerender(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(screen.queryByRole("textbox", { name: "Search this transcript" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search transcript" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search transcript" }));
    expect(screen.getByRole("textbox", { name: "Search this transcript" })).toHaveValue("");
  });

  it("offers a Clear search action when a search has no matches", async () => {
    const user = userEvent.setup();
    setState(turnMessages());
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Search transcript" }));
    await user.type(screen.getByRole("textbox", { name: "Search this transcript" }), "nonexistent-term");

    expect(screen.getByText("No messages match that search.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(screen.getByRole("textbox", { name: "Search this transcript" })).toHaveValue("");
    expect(screen.queryByText("No messages match that search.")).not.toBeInTheDocument();
  });
});

/* jsdom cannot see this render, so these assert only behaviour: that the failed
   branch replaces the spinner and that its button calls back. Whether the box
   is legible, and whether the button survives a large text scale, is the
   `transcript-failed` harness case — captured in WebKit at 1.0 and 1.4. */
describe("a transcript that failed to load", () => {
  function setup(transcriptError: string | null) {
    const selectedAgent = agent("agent-a", null, 0);
    const retryTranscript = vi.fn(async () => {});
    gatewayMock.state = {
      catalog: { revision: 0, agents: [selectedAgent] },
      selectedAgent,
      selectedSnapshot: null,
      pendingMessages: [],
      selectAgent: vi.fn(async () => {}),
      transcriptErrors: transcriptError ? { "agent-a": transcriptError } : {},
      retryTranscript,
    };
    return retryTranscript;
  }

  it("shows the reason and a retry instead of a spinner that never stops", () => {
    setup("Loading the transcript timed out.");
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Loading the transcript timed out.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Loading transcript…")).not.toBeInTheDocument();
  });

  it("keeps the spinner while the transcript is merely still coming", () => {
    setup(null);
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    expect(screen.getByText("Loading transcript…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("asks the store to try that agent again", async () => {
    const retryTranscript = setup("Could not reach the gateway.");
    render(<TranscriptPanel onOpenSessions={() => {}} onOpenActivity={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retryTranscript).toHaveBeenCalledWith("agent-a");
  });
});
