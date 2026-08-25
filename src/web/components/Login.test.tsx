import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Login } from "./Login";

const gatewayMock = vi.hoisted(() => ({ pair: vi.fn(), hadSession: false }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

beforeEach(() => {
  gatewayMock.pair = vi.fn();
  gatewayMock.hadSession = false;
});

describe("Login", () => {
  it("prompts for a fresh pairing on a true first pair", () => {
    render(<Login />);
    expect(screen.getByRole("heading", { name: "Pair this device" })).toBeInTheDocument();
  });

  it("frames the prompt as a session expiry when a prior session existed", () => {
    gatewayMock.hadSession = true;
    render(<Login />);
    expect(screen.getByRole("heading", { name: "Session expired" })).toBeInTheDocument();
  });

  it("disables submit until a token is entered", async () => {
    const user = userEvent.setup();
    render(<Login />);
    const submit = screen.getByRole("button", { name: "Pair device" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Pairing token"), "secret-token");
    expect(submit).toBeEnabled();
  });

  it("pairs with the entered token and clears the field on success", async () => {
    gatewayMock.pair.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Login />);

    const input = screen.getByLabelText("Pairing token");
    await user.type(input, "secret-token");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    await waitFor(() => expect(gatewayMock.pair).toHaveBeenCalledWith("secret-token"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("shows an error message and keeps the token when pairing fails", async () => {
    gatewayMock.pair.mockRejectedValue(new Error("Invalid pairing token"));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid pairing token");
    expect(screen.getByLabelText("Pairing token")).toHaveValue("bad-token");
  });

  it("falls back to a generic error for a non-Error rejection", async () => {
    gatewayMock.pair.mockRejectedValue("nope");
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Pairing failed");
  });
});
