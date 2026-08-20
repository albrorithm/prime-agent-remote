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
  kind: "approval",
  title: "Allow this action?",
  revision: 3,
  options: [
    { id: "deny", label: "Deny", tone: "danger" },
    { id: "allow", label: "Allow once", tone: "safe" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AttentionCard", () => {
  it("allows only one response while the round trip is pending", async () => {
    let finish!: () => void;
    gatewayMock.respond = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<AttentionCard request={request} />);
    const allow = screen.getByRole("button", { name: "Allow once" });
    const deny = screen.getByRole("button", { name: "Deny" });

    await user.click(allow);
    await user.click(deny);
    expect(gatewayMock.respond).toHaveBeenCalledTimes(1);
    expect(gatewayMock.respond).toHaveBeenCalledWith("attention-1", 3, "allow");
    expect(allow).toBeDisabled();
    expect(deny).toBeDisabled();

    finish();
    await waitFor(() => expect(allow).toBeEnabled());
  });
});
