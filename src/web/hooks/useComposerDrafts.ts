import { useEffect, useRef, useState } from "react";

export const DRAFTS_KEY = "prime-web-drafts";
export const MAX_STORED_DRAFTS = 100;
export const MAX_DRAFT_LENGTH = 100_000;
export const MAX_STORED_DRAFT_BYTES = 1_000_000;

function parseDraftsPayload(stored: string): Record<string, string> {
  if (stored.length > MAX_STORED_DRAFT_BYTES) return {};
  const value: unknown = JSON.parse(stored);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const drafts: Record<string, string> = {};
  for (const [agentId, draft] of Object.entries(value).slice(0, MAX_STORED_DRAFTS)) {
    if (!agentId || agentId.length > 256 || agentId === "__proto__" || typeof draft !== "string") continue;
    drafts[agentId] = draft.slice(0, MAX_DRAFT_LENGTH);
  }
  return drafts;
}

/** Reads and validates the drafts payload from one storage, or null if unset. */
function readStoredDrafts(storage: Storage): Record<string, string> | null {
  const stored = storage.getItem(DRAFTS_KEY);
  return stored === null ? null : parseDraftsPayload(stored);
}

export function loadDrafts(): Record<string, string> {
  try {
    const fromLocal = readStoredDrafts(localStorage);
    if (fromLocal !== null) return fromLocal;
  } catch {
    // localStorage may be unavailable; fall through to the legacy key below.
  }
  // No localStorage entry yet — either a fresh install, or a tab that hasn't
  // reloaded since drafts moved from sessionStorage (which iOS PWA discards
  // on tab kill, breaking the "drafts survive a reload" promise). Migrate any
  // legacy draft once, then retire the old key so it can't resurrect a stale
  // draft on a later reload.
  try {
    const fromSession = readStoredDrafts(sessionStorage);
    if (fromSession === null) return {};
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(fromSession));
    } catch {
      // localStorage write failed (e.g. private browsing); drafts still work
      // in memory for this session via the returned value.
    }
    sessionStorage.removeItem(DRAFTS_KEY);
    return fromSession;
  } catch {
    return {};
  }
}

export interface ComposerDrafts {
  /** The draft text for the given agent id, or "" if none is stored. */
  draft: string;
  /** Applies `update` to the full per-agent draft map and persists the result. */
  setDrafts: (update: (current: Record<string, string>) => Record<string, string>) => void;
}

// Drafts persist across agent switches (keyed by agent id), so unlike the
// other composer hooks this one has no reset effect tied to `id`.
export function useComposerDrafts(id: string): ComposerDrafts {
  const [drafts, setDraftsState] = useState<Record<string, string>>(loadDrafts);
  // Per id, the last value this tab knows both it and storage agree on: the
  // value at mount, or the value last adopted from another tab's write.
  // Deliberately NOT updated by this tab's own edits (setDrafts below) — a
  // draft's current value staying equal to this baseline is what marks it
  // "untouched since last sync" (safe to adopt an incoming remote write);
  // once a local edit makes them differ, that id stays a "this tab is
  // actively editing it" conflict until the tab reloads, rather than
  // silently adopting a remote write and clobbering what's being typed.
  const syncedRef = useRef(drafts);

  function setDrafts(update: (current: Record<string, string>) => Record<string, string>) {
    setDraftsState((current) => {
      const next = update(current);
      try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable; drafts still work in memory.
      }
      return next;
    });
  }

  // Two tabs open on the same session each keep their own in-memory copy of
  // this draft map; without this, whichever tab's keystroke happens to write
  // last silently overwrites the other's unsent text. This reconciles on the
  // `storage` event (which only ever fires in *other* tabs, never the one
  // that wrote): per agent id, adopt the incoming value only where this tab
  // has no edit of its own since its last known sync — an id this tab is
  // actively typing into is left alone rather than merged or clobbered, since
  // a real conflict here isn't worth a CRDT for a draft textbox.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      // sessionStorage is only ever read once (legacy migration) and then
      // cleared, never written going forward, so nothing else can raise a
      // same-key `storage` event that isn't this hook's own localStorage
      // write in another tab.
      if (event.key !== DRAFTS_KEY) return;
      let incoming: Record<string, string>;
      try {
        incoming = event.newValue === null ? {} : parseDraftsPayload(event.newValue);
      } catch {
        return;
      }
      setDraftsState((current) => {
        const synced = syncedRef.current;
        const next: Record<string, string> = { ...current };
        let changed = false;
        for (const agentId of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
          const incomingValue = incoming[agentId] ?? "";
          const currentValue = current[agentId] ?? "";
          const syncedValue = synced[agentId] ?? "";
          if (incomingValue === currentValue || currentValue !== syncedValue) continue;
          next[agentId] = incomingValue;
          changed = true;
        }
        if (!changed) return current;
        syncedRef.current = next;
        return next;
      });
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { draft: drafts[id] ?? "", setDrafts };
}
