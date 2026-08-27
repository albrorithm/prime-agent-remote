import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitchHapticButton } from "./SwitchHapticButton";
import { SETTINGS_KEY, SettingsProvider } from "../settings";

function overlay(): HTMLInputElement | null {
  return document.querySelector(".switch-haptic-input");
}

function withHaptics(haptics: boolean) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, haptics }));
}

function stubVibrate(): ReturnType<typeof vi.fn> {
  const vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true, writable: true });
  return vibrate;
}

afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(navigator, "vibrate");
});

describe("SwitchHapticButton", () => {
  it("renders without a settings provider, defaulting to haptics on", () => {
    // MessageActions is rendered bare in its own tests. A control that threw
    // because nobody wrapped it in a provider would be the wrong trade for a
    // preference that has a perfectly good default.
    render(<SwitchHapticButton label="Copy" onActivate={() => {}}>C</SwitchHapticButton>);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(overlay()).toBeInTheDocument();
  });

  it("drops the switch entirely when haptics are off", () => {
    // Not merely ignored: the feedback is iOS toggling a real native control,
    // so there is nothing to suppress after the fact — the control has to go.
    withHaptics(false);
    render(
      <SettingsProvider><SwitchHapticButton label="Copy" onActivate={() => {}}>C</SwitchHapticButton></SettingsProvider>,
    );
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(overlay()).not.toBeInTheDocument();
  });

  it("still activates with haptics off, through the button", () => {
    withHaptics(false);
    const onActivate = vi.fn();
    render(
      <SettingsProvider><SwitchHapticButton label="Copy" onActivate={onActivate}>C</SwitchHapticButton></SettingsProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onActivate).toHaveBeenCalledWith("button");
  });

  it("buzzes the motor on activation where there is one", () => {
    const vibrate = stubVibrate();
    render(<SwitchHapticButton label="Copy" onActivate={() => {}}>C</SwitchHapticButton>);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(vibrate).toHaveBeenCalledWith(10);
    // The switch path is the one Android's overlay actually takes.
    fireEvent.click(overlay()!);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it("does not buzz when haptics are off", () => {
    withHaptics(false);
    const vibrate = stubVibrate();
    render(
      <SettingsProvider><SwitchHapticButton label="Copy" onActivate={() => {}}>C</SwitchHapticButton></SettingsProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("activates without a Vibration API at all, which is every iOS device", () => {
    const onActivate = vi.fn();
    render(<SwitchHapticButton label="Copy" onActivate={onActivate}>C</SwitchHapticButton>);
    expect(navigator.vibrate).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onActivate).toHaveBeenCalledWith("button");
  });
});
