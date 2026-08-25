import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AttentionRequest } from "../../protocol";
import { AttentionCard } from "./AttentionCard";

const gatewayMock = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

const request: AttentionRequest = {
  id: "attention-1",
  agentId: "agent-1",
  kind: "dialog",
  title: "Proceed with this action?",
  revision: 3,
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
    expect(gatewayMock.respond).toHaveBeenCalledWith("attention-1", 3, "confirm");
    expect(confirm).toBeDisabled();
    expect(decline).toBeDisabled();

    finish();
    await waitFor(() => expect(confirm).toBeEnabled());
  });
});
