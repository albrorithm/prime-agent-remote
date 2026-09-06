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
    expect(screen.getByText("Scan the gateway's code, or type it here.")).toBeInTheDocument();
  });

  it("frames the prompt as a session expiry when a prior session existed", () => {
    gatewayMock.hadSession = true;
    render(<Login />);
    expect(screen.getByRole("heading", { name: "Session expired" })).toBeInTheDocument();
    expect(screen.getByText("Your session ended. Enter a new pairing code.")).toBeInTheDocument();
  });

  it("disables submit until a code is entered", async () => {
    const user = userEvent.setup();
    render(<Login />);
    const submit = screen.getByRole("button", { name: "Pair device" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Pairing code"), "secret-code");
    expect(submit).toBeEnabled();
  });

  it("pairs with the entered code and clears the field on success", async () => {
    gatewayMock.pair.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Login />);

    const input = screen.getByLabelText("Pairing code");
    await user.type(input, "secret-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    await waitFor(() => expect(gatewayMock.pair).toHaveBeenCalledWith("secret-code"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("shows an error message and keeps the code when pairing fails", async () => {
    gatewayMock.pair.mockRejectedValue(new Error("Invalid pairing code"));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing code"), "bad-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid pairing code");
    expect(screen.getByLabelText("Pairing code")).toHaveValue("bad-code");
  });

  it("ignores a second submit while the first pairing call is still in flight", async () => {
    let resolvePair: () => void = () => {};
    gatewayMock.pair = vi.fn(() => new Promise<void>((resolve) => { resolvePair = resolve; }));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing code"), "secret-code");
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

    await user.type(screen.getByLabelText("Pairing code"), "bad-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Pairing failed");
  });

  it("never shows a raw status number for any pairing failure", async () => {
    gatewayMock.pair.mockRejectedValue(new Error("Invalid pairing code"));
    const user = userEvent.setup();
    const { container } = render(<Login />);

    await user.type(screen.getByLabelText("Pairing code"), "bad-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    await screen.findByRole("alert");
    expect(container.textContent).not.toMatch(/\b[1-5]\d{2}\b/);
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
    gatewayMock.pair.mockRejectedValue(new Error("Wrong code"));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing code"), "another-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Wrong code"));
  });
});

/* An expired code is not a typo, so it earns a recovery line the plain
   "wrong token" case does not get — the fix is a fresh code, not a retype. */
describe("Login after a pairing code expired", () => {
  it("adds a recovery line under the error when the gateway's title is the expiry one", async () => {
    gatewayMock.pair.mockRejectedValue(new Error("Pairing link expired"));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing code"), "stale-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Pairing link expired");
    expect(screen.getByText(/That code has expired/)).toBeInTheDocument();
    expect(screen.getAllByText("prime-agent-remote token").length).toBeGreaterThan(0);
  });

  it("shows the recovery line for an expired link the same way", () => {
    gatewayMock.linkError = "Pairing link expired";
    render(<Login />);

    expect(screen.getByRole("alert")).toHaveTextContent("Pairing link expired");
    expect(screen.getByText(/That code has expired/)).toBeInTheDocument();
  });

  it("does not add the recovery line for an ordinary wrong code", async () => {
    gatewayMock.pair.mockRejectedValue(new Error("Invalid pairing code"));
    const user = userEvent.setup();
    render(<Login />);

    await user.type(screen.getByLabelText("Pairing code"), "bad-code");
    await user.click(screen.getByRole("button", { name: "Pair device" }));

    await screen.findByRole("alert");
    expect(screen.queryByText(/That code has expired/)).not.toBeInTheDocument();
  });
});
