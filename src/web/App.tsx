import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { AgentsPanel } from "./components/AgentsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Login } from "./components/Login";
import { SessionDashboard } from "./components/SessionDashboard";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useGateway } from "./gateway-store";
import { useDrawerGesture } from "./hooks/useDrawerGesture";
import { useInstalledViewportRecovery } from "./hooks/useInstalledViewportRecovery";

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), input:not([disabled]):not([hidden]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
const HINT_KEY = "prime-web-gesture-hint";
const PERSISTENT_DESKTOP_QUERY = "(min-width: 1100px)";

function isAvailableFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target === document.body || target === document.documentElement) return false;
  if (target.matches(":disabled")) return false;
  let cursor: HTMLElement | null = target;
  while (cursor) {
    if (cursor.hidden || cursor.hasAttribute("inert") || cursor.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(cursor);
    if (style.display === "none" || style.visibility === "hidden") return false;
    cursor = cursor.parentElement;
  }
  return true;
}

function availableFocusTargets(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isAvailableFocusTarget);
}

function usePersistentDesktop(): boolean {
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

function GestureHint() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== "seen";
    } catch {
      return true;
    }
  });

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(HINT_KEY, "seen");
    } catch {
      // Without storage the hint simply shows again next visit.
    }
  }

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(dismiss, 7000);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="gesture-hint" role="note" aria-label="Gesture hint">
      <span>Swipe right for sessions</span>
      <button onClick={dismiss} aria-label="Dismiss hint"><X /></button>
    </div>
  );
}

export function App() {
  useInstalledViewportRecovery();
  const gateway = useGateway();
  const persistentDesktop = usePersistentDesktop();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const sessionsRef = useRef<HTMLElement>(null);
  const activityRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openSessions = useCallback(() => {
    setActivityOpen(false);
    setSessionsOpen(true);
  }, []);
  const gesture = useDrawerGesture({
    open: sessionsOpen,
    disabled: activityOpen || persistentDesktop,
    onOpen: openSessions,
    onClose: () => setSessionsOpen(false),
  });

  useEffect(() => {
    if (!persistentDesktop) return;
    setSessionsOpen(false);
    setActivityOpen(false);
  }, [persistentDesktop]);

  const activeOverlay = !persistentDesktop
    ? sessionsOpen ? sessionsRef : activityOpen ? activityRef : null
    : null;
  useEffect(() => {
    if (!activeOverlay) {
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (!previous) return;
      const fallbackTargets = [
        previous,
        document.querySelector<HTMLElement>(".sessions-trigger button"),
        document.getElementById("transcript-heading"),
        document.querySelector<HTMLElement>("#message-composer"),
      ];
      fallbackTargets.find(isAvailableFocusTarget)?.focus({ preventScroll: true });
      return;
    }
    if (!restoreFocusRef.current && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    const panel = activeOverlay.current;
    if (panel) availableFocusTargets(panel)[0]?.focus({ preventScroll: true });
  }, [activeOverlay]);

  useEffect(() => {
    if (persistentDesktop || (!sessionsOpen && !activityOpen)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSessionsOpen(false);
        setActivityOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const panel = (sessionsOpen ? sessionsRef : activityRef).current;
      if (!panel) return;
      const focusable = availableFocusTargets(panel);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sessionsOpen, activityOpen, persistentDesktop]);

  if (gateway.authRequired) return <Login />;
  if (gateway.connection === "checking") {
    return <main className="splash"><img src="/prime-mark.svg" alt="" /><p>Opening Prime Agent…</p></main>;
  }

  const drawerProgress = gesture.progress ?? (sessionsOpen ? 1 : 0);
  const sessionsModal = !persistentDesktop && (sessionsOpen || gesture.dragging);
  const activityModal = !persistentDesktop && activityOpen;
  const mobileOverlayOpen = sessionsModal || activityModal;
  return (
    <main
      className={`app-shell ${gesture.dragging ? "is-dragging" : ""}`}
      data-sessions-open={sessionsOpen || gesture.dragging ? "true" : "false"}
      data-activity-open={activityOpen ? "true" : "false"}
      data-mobile-modal={mobileOverlayOpen ? "true" : "false"}
      onPointerDown={gesture.handlers.onPointerDown}
      onPointerMove={gesture.handlers.onPointerMove}
      onPointerUp={gesture.handlers.onPointerUp}
      onPointerCancel={gesture.handlers.onPointerCancel}
      style={{ "--drawer-progress": drawerProgress } as React.CSSProperties}
    >
      <div
        className={`shell-global-ui ${mobileOverlayOpen ? "is-modal-hidden" : ""}`}
        aria-hidden={mobileOverlayOpen ? "true" : undefined}
        inert={mobileOverlayOpen ? true : undefined}
      >
        <ConnectionBanner />
        {gateway.connection === "live" && <GestureHint />}
        {gateway.backend === "demo" && <div className="demo-badge">Demo</div>}
      </div>

      <button
        className="shell-scrim sessions-scrim"
        aria-label="Close sessions"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setSessionsOpen(false)}
      />
      <aside
        className="session-drawer"
        ref={sessionsRef}
        aria-label="Sessions"
        role={sessionsModal ? "dialog" : undefined}
        aria-modal={sessionsModal ? "true" : undefined}
        aria-hidden={!persistentDesktop && !sessionsModal ? "true" : undefined}
        inert={!persistentDesktop && !sessionsModal ? true : undefined}
        style={{ transform: `translate3d(${(drawerProgress - 1) * 100}%, 0, 0)` }}
      >
        <AgentsPanel visible={persistentDesktop || sessionsOpen || gesture.dragging} onClose={() => setSessionsOpen(false)} onNavigate={() => setSessionsOpen(false)} />
      </aside>

      <section
        className="conversation-stage"
        aria-hidden={mobileOverlayOpen ? "true" : undefined}
        inert={mobileOverlayOpen ? true : undefined}
      >
        <TranscriptPanel
          onOpenSessions={openSessions}
          onOpenActivity={() => {
            setSessionsOpen(false);
            setActivityOpen(true);
          }}
        />
      </section>

      <button
        className="shell-scrim activity-scrim"
        aria-label="Close session dashboard"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setActivityOpen(false)}
      />
      <aside
        className="activity-drawer"
        ref={activityRef}
        aria-label="Session dashboard"
        role={activityModal ? "dialog" : undefined}
        aria-modal={activityModal ? "true" : undefined}
        aria-hidden={!persistentDesktop && !activityModal ? "true" : undefined}
        inert={!persistentDesktop && !activityModal ? true : undefined}
      >
        <SessionDashboard onClose={() => setActivityOpen(false)} onNavigate={() => setActivityOpen(false)} />
      </aside>
    </main>
  );
}
