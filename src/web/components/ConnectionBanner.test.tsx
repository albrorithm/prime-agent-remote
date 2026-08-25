import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";

const gateway = vi.hoisted(() => ({
  connection: "live",
  error: null as string | null,
  hasReconnected: false,
  reconnect: vi.fn(),
}));
vi.mock("../gateway-store", () => ({ useGateway: () => gateway }));

beforeEach(() => {
  gateway.connection = "live";
  gateway.error = null;
  gateway.hasReconnected = false;
  gateway.reconnect.mockReset();
});

describe("ConnectionBanner", () => {
  it("offers a retry when an HTTP startup error is visible even if the socket is live", async () => {
    gateway.error = "Could not load the root snapshot";
    render(<ConnectionBanner />);

    expect(screen.getByRole("status")).toHaveTextContent("Could not load the root snapshot");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(gateway.reconnect).toHaveBeenCalledTimes(1);
  });

  it("says Connecting on a fresh first attempt", () => {
    gateway.connection = "connecting";
    render(<ConnectionBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
  });

  it("says Reconnecting once the socket has dropped at least once", () => {
    gateway.connection = "connecting";
    gateway.hasReconnected = true;
    render(<ConnectionBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
  });
});
