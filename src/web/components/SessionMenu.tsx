import { Archive, ArchiveRestore, LoaderCircle, Pencil, Pin, PinOff, Power, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentSummary } from "../../protocol";
import { MAX_SESSION_NAME_CHARS } from "../../protocol";
import { useGateway } from "../gateway-store";

interface SessionMenuProps {
  agent: AgentSummary;
  /** The row control that opened the menu. Focus goes back there on close. */
  anchor: HTMLElement;
  onClose: () => void;
  /** Opens the full session view, for the controls that need more than a row of menu items. */
  onOpenControls: (id: string) => void;
  pinned: boolean;
  archived: boolean;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
}

/** What the menu is showing: the list, or one of the two items that needs a second step in place. */
type Mode = "menu" | "rename" | "delete";

/** Space kept between the menu and the panel's edges, and between it and its row. */
const MENU_MARGIN = 6;
/** The strip along the panel's bottom where the floating buttons sit; the menu flips above rather than cover them. */
const FLOATING_BUTTONS_RESERVE = 84;

/**
 * Where the menu goes. Below the row control, right-aligned to it, unless
 * that would run off the bottom of the panel, in which case above it. Offsets
 * are from the panel's own box: the panel is what the menu is positioned in.
 */
function placeMenu(anchor: HTMLElement, panel: HTMLElement, menuHeight: number): { top: number; right: number } {
  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const right = Math.max(MENU_MARGIN, panelRect.right - anchorRect.right);
  const below = anchorRect.bottom - panelRect.top + MENU_MARGIN;
  if (below + menuHeight + FLOATING_BUTTONS_RESERVE <= panelRect.height) return { top: below, right };
  const above = anchorRect.top - panelRect.top - MENU_MARGIN - menuHeight;
  return { top: Math.max(MENU_MARGIN, above), right };
}

/**
 * The row's own options, as a popover beside the row rather than a screen of
 * their own: pin and archive are one tap each, and the two that need a second
 * step (a new name, a confirmed delete) take it in place. The goal, autonomy
 * and heartbeat controls are more than a menu can hold and stay on the full
 * view, which the last item opens.
 */
export function SessionMenu({
  agent,
  anchor,
  onClose,
  onOpenControls,
  pinned,
  archived,
  onTogglePin,
  onToggleArchive,
}: SessionMenuProps) {
  const { deleteSession, rename, stop } = useGateway();
  const menuRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(agent.name);
  const [pending, setPending] = useState<"rename" | "stop" | "delete" | null>(null);
  // Corrected by the layout effect below before the first paint, so nothing
  // is ever shown here; and never hidden meanwhile, because WebKit refuses to
  // focus a hidden element and the focus effect runs before a re-render.
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: MENU_MARGIN, right: MENU_MARGIN });

  const organizable = agent.parentId === null;
  const controlsAvailable = agent.parentId === null && agent.lifecycle === "live";
  const trimmed = name.trim();
  const renameReady = Boolean(trimmed) && trimmed !== agent.name && pending === null;

  // Measured, not guessed: the menu's height depends on which items this
  // session gets, and which of the two in-place steps it is on.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const panel = anchor.closest<HTMLElement>(".agents-panel");
    if (!menu) return;
    // Without the panel there is nothing to place against; shown in the
    // corner rather than never.
    setPosition(panel ? placeMenu(anchor, panel, menu.offsetHeight) : { top: MENU_MARGIN, right: MENU_MARGIN });
  }, [anchor, mode]);

  useEffect(() => {
    if (mode === "rename") nameRef.current?.focus({ preventScroll: true });
    else menuRef.current?.querySelector<HTMLElement>('[role="menuitem"], button')?.focus({ preventScroll: true });
  }, [mode]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    }
    // The list scrolling under an open menu leaves it beside the wrong row.
    // Only the row's own scroll containers count: the document moving (iOS
    // does that around the keyboard) carries the drawer, and the menu, along.
    function onScroll(event: Event) {
      if (!(event.target instanceof Element) || !event.target.contains(anchor)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  function close(restoreFocus = true) {
    onClose();
    if (restoreFocus) queueMicrotask(() => anchor.focus({ preventScroll: true }));
  }

  function items(): HTMLElement[] {
    return [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (mode === "menu") close();
      else setMode("menu");
      return;
    }
    if (mode !== "menu") return;
    const list = items();
    if (!list.length) return;
    const current = list.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % list.length;
    else if (event.key === "ArrowUp") next = (current - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    else if (event.key === "Tab") {
      // A menu is not a place to tab through. Leaving it closes it and puts
      // focus back where it came from, so the drawer's own order resumes.
      event.preventDefault();
      close();
      return;
    } else return;
    event.preventDefault();
    list[next]?.focus();
  }

  async function submitRename() {
    if (!renameReady) return;
    setPending("rename");
    try {
      await rename(agent.id, trimmed);
      close();
    } catch {
      // The gateway store surfaces the error; the typed name stays so it is
      // not lost along with the failure.
      setPending(null);
    }
  }

  async function submitStop() {
    if (pending) return;
    setPending("stop");
    try {
      await stop(agent.id);
      close();
    } catch {
      setPending(null);
    }
  }

  async function submitDelete() {
    if (pending) return;
    setPending("delete");
    try {
      await deleteSession(agent.id, agent.name);
      close(false);
    } catch {
      // Nothing was deleted, so this disarms rather than staying primed.
      setMode("menu");
      setPending(null);
    }
  }

  const style = { top: position.top, right: position.right };

  if (mode === "rename") {
    return (
      <div ref={menuRef} className="session-menu session-menu-step" role="dialog" aria-label={`Rename ${agent.name}`} style={style} onKeyDown={onKeyDown} data-gesture-exclusion>
        <input
          ref={nameRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submitRename();
            }
          }}
          aria-label="Session name"
          maxLength={MAX_SESSION_NAME_CHARS}
          disabled={pending === "rename"}
        />
        <div className="session-menu-step-actions">
          <button type="button" className="secondary-button" disabled={pending === "rename"} onClick={() => setMode("menu")}>Cancel</button>
          <button type="button" className="primary-button" disabled={!renameReady} onClick={() => void submitRename()}>
            {pending === "rename" && <LoaderCircle className="spin" aria-hidden="true" />}
            Rename
          </button>
        </div>
      </div>
    );
  }

  if (mode === "delete") {
    return (
      <div ref={menuRef} className="session-menu session-menu-step" role="dialog" aria-label={`Delete ${agent.name}`} style={style} onKeyDown={onKeyDown} data-gesture-exclusion>
        {/* Naming the session here is the confirmation's whole job: knowing which one is about to go. */}
        <p className="session-menu-note">
          Delete <strong>{agent.name}</strong> and its transcript from this machine? This cannot be undone.
        </p>
        <div className="session-menu-step-actions">
          <button type="button" className="secondary-button" disabled={pending === "delete"} onClick={() => setMode("menu")}>Cancel</button>
          <button type="button" className="danger-button" disabled={pending === "delete"} onClick={() => void submitDelete()}>
            {pending === "delete" && <LoaderCircle className="spin" aria-hidden="true" />}
            {pending === "delete" ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="session-menu" role="menu" aria-label={`${agent.name} options`} style={style} onKeyDown={onKeyDown} data-gesture-exclusion>
      {organizable && (
        <>
          <button type="button" role="menuitem" onClick={() => { onTogglePin(agent.id); close(); }}>
            {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" role="menuitem" onClick={() => { onToggleArchive(agent.id); close(); }}>
            {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
            {archived ? "Unarchive" : "Archive"}
          </button>
        </>
      )}
      {agent.capabilities.rename && (
        <button type="button" role="menuitem" onClick={() => { setName(agent.name); setMode("rename"); }}>
          <Pencil aria-hidden="true" /> Rename…
        </button>
      )}
      {controlsAvailable && (
        <button type="button" role="menuitem" onClick={() => { onOpenControls(agent.id); onClose(); }}>
          <SlidersHorizontal aria-hidden="true" /> Goal, autonomy, heartbeat…
        </button>
      )}
      {agent.capabilities.stop && (
        <button type="button" role="menuitem" disabled={pending !== null} onClick={() => void submitStop()}>
          {pending === "stop" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Power aria-hidden="true" />}
          {pending === "stop" ? "Ending session…" : "End session"}
        </button>
      )}
      {agent.capabilities.delete && (
        <button type="button" role="menuitem" className="session-menu-danger" onClick={() => setMode("delete")}>
          <Trash2 aria-hidden="true" /> Delete…
        </button>
      )}
    </div>
  );
}
