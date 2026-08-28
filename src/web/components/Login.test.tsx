import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Login } from "./Login";

const gatewayMock = vi.hoisted(() => ({ pair: vi.fn(), hadSession: false, linkError: null as string | null }));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

beforeEach(() => {
  gatewayMock.pair = vi.fn();
  gatewayMock.hadSession = false;
  gatewayMock.linkError = null;
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

  it("ignores a second submit while the first pairing call is still in flight", async () => {
    let resolvePair: () => void = () => {};
    gatewayMock.pair = vi.fn(() => new Promise<void>((resolve) => { resolvePair = resolve; }));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing token"), "secret-token");
    const form = screen.getByRole("button", { name: "Pair device" }).closest("form")!;

    // Fire two submits back to back, before React has re-rendered the
    // disabled submit button — a double-Enter or a slow-network double-tap
    // can race past the disabled attribute this way.
    fireEvent.submit(form);
    fireEvent.submit(form);

    resolvePair();
    await waitFor(() => expect(gatewayMock.pair).toHaveBeenCalledTimes(1));
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

/* A pairing link that failed leaves the user on this screen with no idea why,
   unless this screen says so: it is the whole app at that point, and the error
   banner is not part of it. */
describe("Login after a pairing link failed", () => {
  it("says what went wrong with the link", () => {
    gatewayMock.linkError = "Pairing failed";
    render(<Login />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pairing failed");
  });

  it("hands the message over to the user's own attempt", async () => {
    gatewayMock.linkError = "Pairing failed";
    gatewayMock.pair.mockRejectedValue(new Error("Wrong token"));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing token"), "another-token");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Wrong token"));
  });
});
