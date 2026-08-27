import { afterEach, describe, expect, it, vi } from "vitest";
import { vibrateTap } from "./haptics";

afterEach(() => {
  Reflect.deleteProperty(navigator, "vibrate");
});

function stubVibrate(implementation?: () => boolean) {
  const vibrate = vi.fn(implementation ?? (() => true));
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true, writable: true });
  return vibrate;
}

describe("vibrateTap", () => {
  it("asks for a pulse short enough to read as a tick", () => {
    const vibrate = stubVibrate();
    vibrateTap(true);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("does nothing when the preference is off", () => {
    const vibrate = stubVibrate();
    vibrateTap(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("is a no-op where there is no Vibration API, which is all of iOS", () => {
    expect(navigator.vibrate).toBeUndefined();
    expect(() => vibrateTap(true)).not.toThrow();
  });

  it("swallows an engine that throws rather than refusing the tap", () => {
    // A hidden document or a policy setting can make this throw. The tap it
    // accompanies still has to happen.
    stubVibrate(() => { throw new Error("not allowed"); });
    expect(() => vibrateTap(true)).not.toThrow();
  });
});
