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
  it("surfaces an action error without a Retry button when the socket is live", () => {
    // A `live` connection with an error set is a failed mutation (e.g.
    // "Could not end the session"), not a connectivity problem. Offering a
    // Retry that calls reconnect() would be dishonest — it does nothing for
    // this kind of failure.
    gateway.error = "Could not end the session";
    render(<ConnectionBanner />);

    expect(screen.getByRole("status")).toHaveTextContent("Could not end the session");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Retry when a connection error surfaces while reconnecting", async () => {
    gateway.connection = "connecting";
    gateway.error = "Realtime connection timed out. Retrying…";
    render(<ConnectionBanner />);

    expect(screen.getByRole("status")).toHaveTextContent("Realtime connection timed out. Retrying…");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(gateway.reconnect).toHaveBeenCalledTimes(1);
  });

  it("offers Reconnect while offline even without an error message", async () => {
    gateway.connection = "offline";
    render(<ConnectionBanner />);

    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
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
