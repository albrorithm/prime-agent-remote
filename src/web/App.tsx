import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { AgentsPanel } from "./components/AgentsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Login } from "./components/Login";
import { SessionDashboard } from "./components/SessionDashboard";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useGateway } from "./gateway-store";
import { useDrawerGesture } from "./hooks/useDrawerGesture";
import { useViewportGeometry } from "./hooks/useViewportGeometry";
import { usePersistentDesktop } from "./hooks/usePersistentDesktop";

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), input:not([disabled]):not([hidden]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
const HINT_KEY = "prime-web-gesture-hint";

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
  useViewportGeometry();
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
    /* The panel itself, not its first button. Moving focus into an
       `aria-modal` dialog is not optional — screen readers need it and the Tab
       trap below assumes focus is inside — but landing it on a control made
       WebKit paint that control's focus ring, so opening the drawer on a fresh
       launch put a bright circle around the settings gear that no one had
       touched. It showed up on the first open only: after any pointer
       interaction WebKit stops treating a programmatic focus as keyboard-like.
       Focusing the container is the ordinary dialog pattern and rings nothing. */
    const panel = activeOverlay.current;
    panel?.focus({ preventScroll: true });
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
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
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
      {/* A mutation error (e.g. "Could not end the session") can fire while a
          drawer or the manage sheet is open. It must stay visible instead of
          being hidden with the rest of the connection chrome, so this banner
          gets its own shell-global-ui wrapper that only hides on overlay when
          there's nothing to say. */}
      <div
        className={`shell-global-ui is-alert-layer ${mobileOverlayOpen && !gateway.error ? "is-modal-hidden" : ""}`}
        aria-hidden={mobileOverlayOpen && !gateway.error ? "true" : undefined}
        inert={mobileOverlayOpen && !gateway.error ? true : undefined}
      >
        <ConnectionBanner />
      </div>
      <div
        className={`shell-global-ui ${mobileOverlayOpen ? "is-modal-hidden" : ""}`}
        aria-hidden={mobileOverlayOpen ? "true" : undefined}
        inert={mobileOverlayOpen ? true : undefined}
      >
        {gateway.connection === "live" && <GestureHint />}
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
        tabIndex={-1}
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
        tabIndex={-1}
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
