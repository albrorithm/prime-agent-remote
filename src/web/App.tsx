import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ActivityPanel } from "./components/ActivityPanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Login } from "./components/Login";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useGateway } from "./gateway-store";
import { useDrawerGesture } from "./hooks/useDrawerGesture";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const HINT_KEY = "prime-web-gesture-hint";

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
      <span>Swipe from the left edge for sessions</span>
      <button onClick={dismiss} aria-label="Dismiss hint"><X /></button>
    </div>
  );
}

export function App() {
  const gateway = useGateway();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const sessionsRef = useRef<HTMLElement>(null);
  const activityRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const gesture = useDrawerGesture({
    open: sessionsOpen,
    disabled: activityOpen,
    onOpen: () => {
      setActivityOpen(false);
      setSessionsOpen(true);
    },
    onClose: () => setSessionsOpen(false),
  });

  const activeOverlay = sessionsOpen ? sessionsRef : activityOpen ? activityRef : null;
  useEffect(() => {
    if (!activeOverlay) {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
      return;
    }
    if (!restoreFocusRef.current && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    activeOverlay.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [activeOverlay]);

  useEffect(() => {
    if (!sessionsOpen && !activityOpen) return;
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
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sessionsOpen, activityOpen]);

  if (gateway.authRequired) return <Login />;
  if (gateway.connection === "checking") {
    return <main className="splash"><img src="/prime-mark.svg" alt="" /><p>Opening Prime Agent…</p></main>;
  }

  const drawerProgress = gesture.progress ?? (sessionsOpen ? 1 : 0);
  return (
    <main
      className={`app-shell ${gesture.dragging ? "is-dragging" : ""}`}
      data-sessions-open={sessionsOpen || gesture.dragging ? "true" : "false"}
      data-activity-open={activityOpen ? "true" : "false"}
      onPointerDown={gesture.handlers.onPointerDown}
      onPointerMove={gesture.handlers.onPointerMove}
      onPointerUp={gesture.handlers.onPointerUp}
      onPointerCancel={gesture.handlers.onPointerCancel}
      style={{ "--drawer-progress": drawerProgress } as React.CSSProperties}
    >
      <ConnectionBanner />
      {gateway.connection === "live" && <GestureHint />}
      {gateway.backend === "demo" && <div className="demo-badge">Demo</div>}

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
        style={{ transform: `translate3d(${(drawerProgress - 1) * 100}%, 0, 0)` }}
      >
        <AgentsPanel visible={sessionsOpen || gesture.dragging} onClose={() => setSessionsOpen(false)} onNavigate={() => setSessionsOpen(false)} />
      </aside>

      <section className="conversation-stage">
        <TranscriptPanel
          onOpenSessions={() => {
            setActivityOpen(false);
            setSessionsOpen(true);
          }}
          onOpenActivity={() => {
            setSessionsOpen(false);
            setActivityOpen(true);
          }}
        />
      </section>

      <button
        className="shell-scrim activity-scrim"
        aria-label="Close activity"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setActivityOpen(false)}
      />
      <aside className="activity-drawer" ref={activityRef} aria-label="Agent activity">
        <ActivityPanel onClose={() => setActivityOpen(false)} onNavigate={() => setActivityOpen(false)} />
      </aside>
    </main>
  );
}
