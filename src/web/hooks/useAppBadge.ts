import { useEffect } from "react";

/**
 * The Badging API, which no lib.dom in this toolchain declares yet.
 * `setAppBadge(0)` is specified as a clear, but `clearAppBadge` is the
 * explicit spelling and some engines shipped only one of the pair.
 */
interface BadgingNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Mirrors the app-wide attention count onto the home-screen icon.
 *
 * Two things this deliberately does not do. It never clears on unmount: the
 * badge exists precisely to survive the app being closed, and clearing it on
 * teardown would wipe it at the moment it starts mattering. And it never
 * reports failure — on iOS the call resolves into nothing until notification
 * permission is granted (16.4+), which is a state the Settings panel explains
 * rather than something to surface here.
 */
export function useAppBadge(count: number): void {
  useEffect(() => {
    const badging = navigator as Navigator & BadgingNavigator;
    try {
      const applied = count > 0
        ? badging.setAppBadge?.(count)
        : badging.clearAppBadge?.() ?? badging.setAppBadge?.(0);
      void applied?.catch(() => {});
    } catch {
      // Some engines throw synchronously outside a secure or installed context.
    }
  }, [count]);
}
