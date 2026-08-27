import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { PROTOCOL_VERSION } from "../../protocol";
import { DRAFTS_KEY } from "../hooks/useComposerDrafts";
import { SettingsProvider, SETTINGS_KEY } from "../settings";
import { SettingsPanel } from "./SettingsPanel";

const gatewayMock = vi.hoisted(() => ({
  backend: "demo" as "demo" | "prime" | null,
  csrfToken: "csrf",
  push: null as { enabled: boolean; publicKey: string | null } | null,
  signOut: vi.fn(),
}));
vi.mock("../gateway-store", () => ({ useGateway: () => gatewayMock }));

const pushMock = vi.hoisted(() => ({
  readPushState: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));
vi.mock("../push", () => pushMock);

const apiMock = vi.hoisted(() => ({
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
}));
// `humanizeError` is real: the panel renders whatever it returns, and a stub
// would let a test pass on a message no user would ever see.
vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  ...apiMock,
}));

function device(overrides: Partial<import("../../protocol").DeviceSummary> = {}) {
  return {
    id: "device-1",
    name: "iPhone",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: new Date().toISOString(),
    current: false,
    ...overrides,
  };
}

function renderPanel(onClose = vi.fn()) {
  return {
    onClose,
    ...render(<SettingsProvider><SettingsPanel onClose={onClose} /></SettingsProvider>),
  };
}

function storedSettings(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
}

beforeEach(() => {
  gatewayMock.backend = "demo";
  gatewayMock.csrfToken = "csrf";
  gatewayMock.push = { enabled: true, publicKey: "application-server-key" };
  gatewayMock.signOut = vi.fn().mockResolvedValue(undefined);
  pushMock.readPushState.mockReset().mockResolvedValue("off");
  pushMock.enablePush.mockReset().mockResolvedValue("on");
  pushMock.disablePush.mockReset().mockResolvedValue(undefined);
  apiMock.listDevices.mockReset().mockResolvedValue({ devices: [] });
  apiMock.revokeDevice.mockReset().mockResolvedValue({ revoked: true, self: false });
});

// The panel stamps --text-scale on the document, which outlives the render.
afterEach(() => {
  document.documentElement.style.removeProperty("--text-scale");
});

describe("SettingsPanel", () => {
  it("closes the sub-view without borrowing the desktop-hidden drawer-close class", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    const close = screen.getByRole("button", { name: "Close settings" });
    expect(close).not.toHaveClass("drawer-close");

    await user.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists a reading toggle", async () => {
    const user = userEvent.setup();
    renderPanel();

    const rawMarkdown = screen.getByRole("checkbox", { name: "Show raw Markdown" });
    expect(rawMarkdown).not.toBeChecked();

    await user.click(rawMarkdown);

    expect(rawMarkdown).toBeChecked();
    expect(storedSettings().rawMarkdown).toBe(true);
  });

  it("offers every reading and composer toggle", () => {
    renderPanel();
    for (const name of [
      "Wrap long code lines",
      "Syntax highlighting",
      "Show raw Markdown",
      "Timestamps",
      "Collapse finished turns",
      "Enter sends message",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeEnabled();
    }
  });

  it("applies reduce motion to the document", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Always reduce" }));

    expect(document.documentElement.dataset.reduceMotion).toBe("always");
    expect(storedSettings().reduceMotion).toBe("always");
  });

  it("switches theme, because the light palette ships with this build", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Light" }));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(storedSettings().theme).toBe("light");
  });

  it("scales the type, since every size in the stylesheet is now a rem off the root", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Larger" }));

    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("1.15");
    expect(storedSettings().textScale).toBe(1.15);

    await user.click(screen.getByRole("radio", { name: "Largest" }));

    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("1.3");
    expect(storedSettings().textScale).toBe(1.3);
  });

  it("reports the backend and protocol version", () => {
    gatewayMock.backend = "prime";
    renderPanel();

    expect(screen.getByText("Backend").nextElementSibling).toHaveTextContent("Prime Agent");
    expect(screen.getByText("Protocol").nextElementSibling).toHaveTextContent(`v${PROTOCOL_VERSION}`);
  });

  it("clears drafts and settings only after a confirmation, then reloads", async () => {
    const user = userEvent.setup();
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "half a message" }));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, timestamps: false }));
    const reload = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
    try {
      renderPanel();

      await user.click(screen.getByRole("button", { name: /Clear local data/ }));
      expect(localStorage.getItem(DRAFTS_KEY)).not.toBeNull();
      expect(reload).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Clear local data" }));

      expect(localStorage.getItem(DRAFTS_KEY)).toBeNull();
      expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });

  it("signs out through the gateway", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(gatewayMock.signOut).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations", async () => {
    const { container } = renderPanel();
    // jsdom computes no real styles, so color-contrast can only report noise
    // (and reaches for an unimplemented canvas).
    const results = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("SettingsPanel notifications", () => {
  // Permission is requested from this button and nowhere else. A prompt fired
  // on load is either ignored or auto-denied, and a denial is permanent.
  it("asks for permission only when the button is pressed", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("button", { name: /Turn on notifications/ });
    expect(pushMock.enablePush).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Turn on notifications/ }));
    expect(pushMock.enablePush).toHaveBeenCalledWith("application-server-key", "csrf", false);
    expect(await screen.findByText("On for this device")).toBeInTheDocument();
  });

  it("turns notifications back off", async () => {
    const user = userEvent.setup();
    pushMock.readPushState.mockResolvedValue("on");
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /Turn off notifications/ }));
    expect(pushMock.disablePush).toHaveBeenCalledWith("csrf");
  });

  // A page whose prompt was refused can never show it again, so offering a
  // switch here would be a loop with no exit.
  it("explains a blocked permission instead of offering a dead switch", async () => {
    pushMock.readPushState.mockResolvedValue("denied");
    renderPanel();

    expect(await screen.findByText(/can't ask again/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /notifications/i })).not.toBeInTheDocument();
  });

  // A gateway mints its own keys now, so this state means something went wrong
  // writing them — not that nobody set them up. Sending the user off to
  // configure VAPID keys would point them at the wrong thing entirely.
  it("blames the gateway, not the operator, when it offers no keys", async () => {
    pushMock.readPushState.mockResolvedValue("unconfigured");
    gatewayMock.push = { enabled: false, publicKey: null };
    renderPanel();

    expect(await screen.findByText(/isn't offering notifications/)).toBeInTheDocument();
    expect(screen.queryByText(/VAPID/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /notifications/i })).not.toBeInTheDocument();
  });

  it("points an unsupported browser at the Home Screen instead of a switch", async () => {
    pushMock.readPushState.mockResolvedValue("unsupported");
    renderPanel();

    expect(await screen.findByText(/add Prime Agent to the Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /notifications/i })).not.toBeInTheDocument();
  });

  it("surfaces a failure to turn notifications on", async () => {
    const user = userEvent.setup();
    pushMock.enablePush.mockRejectedValue(new Error("Push notifications are not configured"));
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /Turn on notifications/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Push notifications are not configured");
  });
});

describe("SettingsPanel paired devices", () => {
  it("lists devices and marks the one being used", async () => {
    apiMock.listDevices.mockResolvedValue({
      devices: [device({ id: "a", name: "iPhone", current: true }), device({ id: "b", name: "iPad" })],
    });
    renderPanel();

    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    expect(screen.getByText("iPad")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
  });

  // Revoking is irreversible from the phone's side — it has to pair again with
  // the setup token — so it takes the same two taps a session delete does.
  it("takes two taps to revoke, and offers a way back from the first", async () => {
    const user = userEvent.setup();
    apiMock.listDevices.mockResolvedValue({ devices: [device({ name: "Old iPad" })] });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Revoke Old iPad" }));
    expect(apiMock.revokeDevice).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiMock.revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revoke Old iPad" })).toBeInTheDocument();
  });

  it("revokes another device and re-reads the list rather than guessing at it", async () => {
    const user = userEvent.setup();
    apiMock.listDevices
      .mockResolvedValueOnce({ devices: [device({ id: "b", name: "Old iPad" }), device({ id: "a", current: true })] })
      .mockResolvedValue({ devices: [device({ id: "a", current: true })] });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Revoke Old iPad" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(apiMock.revokeDevice).toHaveBeenCalledWith("csrf", "b");
    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    expect(screen.queryByText("Old iPad")).not.toBeInTheDocument();
    expect(gatewayMock.signOut).not.toHaveBeenCalled();
  });

  // Revoking your own device already ended the session server-side. Going
  // through signOut is what drops the push subscription and lands on Login,
  // rather than leaving a dead session rendering.
  it("signs out when the device revoked is this one", async () => {
    const user = userEvent.setup();
    apiMock.listDevices.mockResolvedValue({ devices: [device({ name: "iPhone", current: true })] });
    apiMock.revokeDevice.mockResolvedValue({ revoked: true, self: true });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Revoke iPhone" }));
    await user.click(screen.getByRole("button", { name: "Revoke and sign out" }));

    expect(gatewayMock.signOut).toHaveBeenCalled();
  });

  it("says nothing at all when the list cannot be read", async () => {
    apiMock.listDevices.mockRejectedValue(new Error("nope"));
    renderPanel();

    expect(await screen.findByText(/Appearance/i)).toBeInTheDocument();
    expect(screen.queryByText("Paired devices")).not.toBeInTheDocument();
  });
});
