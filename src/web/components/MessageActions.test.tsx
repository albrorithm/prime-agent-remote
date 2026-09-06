import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../protocol";
import type { useGateway } from "../gateway-store";
import { MessageActions, shareSupported } from "./MessageActions";

type GatewayMockState = Pick<ReturnType<typeof useGateway>, "catalog" | "selectedAgent">;

const gatewayMock = vi.hoisted(() => ({ state: null as GatewayMockState | null }));

vi.mock("../gateway-store", () => ({
  useGateway: () => gatewayMock.state,
}));

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "agent-1",
    rootId: "agent-1",
    parentId: null,
    depth: 0,
    name: "Hello.",
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: { send: true, abort: true, resume: false, rename: false, stop: false, deactivate: false, delete: false, respond: true, images: false },
    ...overrides,
  };
}

function setGateway(agents: AgentSummary[], selected: AgentSummary) {
  gatewayMock.state = { catalog: { revision: 1, agents }, selectedAgent: selected };
}

/** Stubs a selection anchored inside `container`, as if the user long-pressed the message text. */
function stubSelectionWithin(container: Element, selectedText: string) {
  const fakeSelection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: container.firstChild ?? container,
    toString: () => selectedText,
  } as unknown as Selection;
  vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection);
}

function stubClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  setGateway([agent()], agent());
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

describe("MessageActions", () => {
  it("renders nothing for an empty message", () => {
    const { container } = render(<MessageActions text="" label="Hello" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("copies the exact message text and announces the result", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<MessageActions text="one `two` three" label="Hello" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeText).toHaveBeenCalledWith("one `two` three");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("survives a denied clipboard without breaking the row", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<MessageActions text="body" label="Hello" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument());
  });

  it("hides Share until the platform provides it", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    expect(shareSupported()).toBe(false);
    const { unmount } = render(<MessageActions text="body" label="Hello" />);
    expect(screen.queryByRole("button", { name: "Share message" })).toBeNull();
    unmount();

    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<MessageActions text="body" label="Hello" />);
    await userEvent.click(screen.getByRole("button", { name: "Share message" }));
    expect(share).toHaveBeenCalledWith({ text: "body" });
  });

  it("names the group after the speaker so screen readers can tell rows apart", () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<MessageActions text="body" label="Hello" />);
    expect(screen.getByRole("group", { name: "Hello message actions" })).toBeInTheDocument();
  });

});
