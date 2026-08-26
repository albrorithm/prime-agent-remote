import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppBadge } from "./useAppBadge";

const original = Object.getOwnPropertyDescriptors(navigator);

function installBadging(overrides: Partial<{
  setAppBadge: unknown;
  clearAppBadge: unknown;
}>): void {
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(navigator, key, { value, writable: true, configurable: true });
  }
}

afterEach(() => {
  for (const key of ["setAppBadge", "clearAppBadge"]) {
    if (key in original) Object.defineProperty(navigator, key, original[key]);
    else delete (navigator as unknown as Record<string, unknown>)[key];
  }
});

describe("useAppBadge", () => {
  it("sets the badge to the count and clears it at zero", () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    installBadging({ setAppBadge, clearAppBadge });

    const { rerender } = renderHook(({ count }) => useAppBadge(count), { initialProps: { count: 3 } });
    expect(setAppBadge).toHaveBeenCalledWith(3);

    rerender({ count: 0 });
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("falls back to setAppBadge(0) when the engine has no clearAppBadge", () => {
    const setAppBadge = vi.fn(async () => {});
    installBadging({ setAppBadge, clearAppBadge: undefined });

    renderHook(() => useAppBadge(0));
    expect(setAppBadge).toHaveBeenCalledWith(0);
  });

  it("does nothing on an engine without the Badging API", () => {
    installBadging({ setAppBadge: undefined, clearAppBadge: undefined });
    expect(() => renderHook(() => useAppBadge(2))).not.toThrow();
  });

  // iOS rejects until notification permission is granted, and some engines
  // throw outright outside an installed context. Neither may reach the app.
  it("swallows a rejected or thrown badge update", () => {
    installBadging({
      setAppBadge: vi.fn(() => Promise.reject(new Error("not allowed"))),
      clearAppBadge: vi.fn(() => { throw new Error("not allowed"); }),
    });

    expect(() => renderHook(() => useAppBadge(1))).not.toThrow();
    expect(() => renderHook(() => useAppBadge(0))).not.toThrow();
  });
});
