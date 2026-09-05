import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionRequest } from "../../protocol";
import { AttentionCard, clearAttentionDrafts } from "./AttentionCard";

const gatewayMock = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

const request: AttentionRequest = {
  id: "attention-1",
  agentId: "agent-1",
  kind: "dialog",
  title: "Proceed with this action?",
  revision: 3,
  reply: { kind: "choice" },
  options: [
    { id: "__prime_cancel__", label: "Decline", tone: "danger" },
    { id: "confirm", label: "Confirm", tone: "safe" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AttentionCard", () => {
  it("allows only one response while the round trip is pending", async () => {
    let finish!: () => void;
    gatewayMock.respond = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<AttentionCard request={request} />);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    const decline = screen.getByRole("button", { name: "Decline" });

    await user.click(confirm);
    await user.click(decline);
    expect(gatewayMock.respond).toHaveBeenCalledTimes(1);
    expect(gatewayMock.respond).toHaveBeenCalledWith("attention-1", 3, { optionId: "confirm" });
    expect(confirm).toBeDisabled();
    expect(decline).toBeDisabled();

    finish();
    await waitFor(() => expect(confirm).toBeEnabled());
  });
});

describe("AttentionCard text replies", () => {
  const line: AttentionRequest = {
    id: "line-1",
    agentId: "agent-1",
    kind: "question",
    title: "Which branch should the release build use?",
    revision: 2,
    reply: { kind: "text", multiline: false, placeholder: "main" },
    options: [{ id: "__prime_cancel__", label: "Cancel", tone: "danger" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const document: AttentionRequest = {
    ...line,
    id: "doc-1",
    title: "Edit the release notes",
    reply: { kind: "text", multiline: true, prefill: "## Notes\n\n- one" },
  };

  beforeEach(() => {
    clearAttentionDrafts();
    gatewayMock.respond = vi.fn(async () => {});
  });

  it("answers a single-line request from its field, on Enter or Submit", async () => {
    const user = userEvent.setup();
    render(<AttentionCard request={line} />);
    const field = screen.getByRole("textbox", { name: "Your answer" });
    expect(field).toHaveAttribute("placeholder", "main");
    await user.type(field, "release/2{Enter}");
    expect(gatewayMock.respond).toHaveBeenCalledWith("line-1", 2, { text: "release/2" });
  });

  it("starts a document from its prefill and sends it on Cmd+Enter, never on Enter", async () => {
    const user = userEvent.setup();
    render(<AttentionCard request={document} />);
    const field = screen.getByRole("textbox", { name: "Your answer" });
    expect(field).toHaveValue("## Notes\n\n- one");
    await user.type(field, "{Enter}- two");
    expect(gatewayMock.respond).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(gatewayMock.respond).toHaveBeenCalledWith("doc-1", 2, { text: "## Notes\n\n- one\n- two" });
  });

  it("keeps what was typed across an unmount and forgets it once sent", async () => {
    const user = userEvent.setup();
    const first = render(<AttentionCard request={line} />);
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "half an ans");
    first.unmount();
    const second = render(<AttentionCard request={line} />);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("half an ans");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(gatewayMock.respond).toHaveBeenCalledWith("line-1", 2, { text: "half an ans" }));
    second.unmount();
    render(<AttentionCard request={line} />);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("");
  });

  it("cancels through the request's own option, and refuses everything once the deadline has passed", async () => {
    const user = userEvent.setup();
    render(<AttentionCard request={line} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(gatewayMock.respond).toHaveBeenCalledWith("line-1", 2, { optionId: "__prime_cancel__" });

    gatewayMock.respond = vi.fn(async () => {});
    render(<AttentionCard request={{ ...line, id: "late", expiresAt: "2020-01-01T00:00:00.000Z" }} />);
    expect(screen.getByRole("timer")).toHaveTextContent("Expired");
    expect(screen.getByRole("status")).toHaveTextContent(/expired before it was answered/);
    const [, lateSubmit] = screen.getAllByRole("button", { name: "Submit" });
    expect(lateSubmit).toBeDisabled();
    await user.click(lateSubmit!);
    expect(gatewayMock.respond).not.toHaveBeenCalled();
  });

  it("shows the time left on a request that has a deadline", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      render(<AttentionCard request={{ ...line, expiresAt: "2026-01-01T00:02:30Z" }} />);
      expect(screen.getByRole("timer")).toHaveTextContent("2:30");
      act(() => { vi.advanceTimersByTime(100_000); });
      expect(screen.getByRole("timer")).toHaveTextContent("0:50");
      expect(screen.getByRole("timer")).toHaveClass("urgent");
    } finally {
      vi.useRealTimers();
    }
  });
});
