import { useEffect, useState } from "react";

const PERSISTENT_DESKTOP_QUERY = "(min-width: 1100px)";

/**
 * Tracks the same ≥1100px breakpoint the layout CSS uses to switch from
 * mobile drawers/FABs to a persistent three-column desktop shell, so
 * components can swap idioms (e.g. a FAB for a header button) in sync with
 * the CSS instead of guessing at a second, drifting threshold.
 */
export function usePersistentDesktop(): boolean {
  const [persistent, setPersistent] = useState(() =>
    typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia(PERSISTENT_DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PERSISTENT_DESKTOP_QUERY);
    const update = () => setPersistent(query.matches);
    update();
    if (typeof query.addEventListener === "function") query.addEventListener("change", update);
    else query.addListener?.(update);
    return () => {
      if (typeof query.removeEventListener === "function") query.removeEventListener("change", update);
      else query.removeListener?.(update);
    };
  }, []);
  return persistent;
}
