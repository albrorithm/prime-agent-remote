import { useSyncExternalStore } from "react";

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

/*
 * The drafts map lives here as one module-level singleton rather than one
 * React state per `useComposerDrafts` call. That used to be per-instance
 * state, which was fine while the composer was the only caller — but a quote
 * action needs to write into an agent's draft from a component that isn't
 * that agent's composer (its own session, to hand a quotation to whoever
 * reads it next; or another session entirely, forwarding one up to a parent),
 * and per-instance state has no way to tell the composer's already-mounted
 * instance that anything changed: the `storage` DOM event this file also
 * listens for is real only for a *different* document, never for a write
 * this same tab just made. A second independent copy of the drafts map would
 * either miss the write (nothing tells the composer to re-read) or race it
 * (two stale snapshots each thinking they hold the latest text).
 *
 * A shared store sidesteps both: every `setDrafts` call, from whichever
 * component made it, is a synchronous update to the one object every mounted
 * caller reads via `useSyncExternalStore`, so no caller needs telling.
 */
let store: Record<string, string> | null = null;
// Baseline against which "has this tab edited this id since the last thing it
// agreed with storage" is judged. Only ever moved by adopting a cross-tab
// write (see `onStorage`) — never by this tab's own edits, which is what
// makes an id "still locally dirty" a real question to ask of it.
let synced: Record<string, string> = {};
const listeners = new Set<() => void>();

function ensureLoaded(): Record<string, string> {
  if (store === null) {
    store = loadDrafts();
    synced = store;
  }
  return store;
}

function notify() {
  for (const listener of listeners) listener();
}

function commit(next: Record<string, string>) {
  store = next;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable; drafts still work in memory.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Record<string, string> {
  return ensureLoaded();
}

// Two tabs open on the same session each keep their own copy of this drafts
// map; without this, whichever tab's keystroke happens to write last silently
// overwrites the other's unsent text. This reconciles on the `storage` event
// (which fires only in *other* tabs, never this one — this tab's own writes
// reach every caller directly through `commit` above): per agent id, adopt
// the incoming value only where this tab has no edit of its own since its
// last known sync — an id this tab is actively typing into is left alone
// rather than merged or clobbered, since a real conflict here isn't worth a
// CRDT for a draft textbox.
function onStorage(event: StorageEvent) {
  if (event.key !== DRAFTS_KEY) return;
  const current = ensureLoaded();
  let incoming: Record<string, string>;
  try {
    incoming = event.newValue === null ? {} : parseDraftsPayload(event.newValue);
  } catch {
    return;
  }
  const next: Record<string, string> = { ...current };
  const adopted: Record<string, string> = {};
  for (const agentId of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
    const incomingValue = incoming[agentId] ?? "";
    const currentValue = current[agentId] ?? "";
    const syncedValue = synced[agentId] ?? "";
    if (incomingValue === currentValue || currentValue !== syncedValue) continue;
    next[agentId] = incomingValue;
    adopted[agentId] = incomingValue;
  }
  if (Object.keys(adopted).length === 0) return;
  /* Only the ids actually adopted advance the baseline. Assigning `next`
     wholesale marked every id as in sync, including the ones the loop had
     just skipped for being locally edited — so a remote write to a
     different agent quietly made this tab's own unsent draft look
     untouched, and the next write to it clobbered mid-typing. Which is
     precisely what the conflict rule above exists to prevent. */
  synced = { ...synced, ...adopted };
  store = next;
  notify();
}

let listening = false;
function ensureListening() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("storage", onStorage);
  listening = true;
}

/**
 * Test-only escape hatch: the store above is a module singleton so every
 * caller in a tab shares it, which means it also survives across `it()`
 * blocks in the same test file unless something clears it. Production code
 * has no reason to call this — the store should only ever go away with the
 * page.
 */
export function resetComposerDraftsStoreForTests(): void {
  store = null;
  synced = {};
}

export function useComposerDrafts(id: string): ComposerDrafts {
  ensureListening();
  const drafts = useSyncExternalStore(subscribe, getSnapshot);

  function setDrafts(update: (current: Record<string, string>) => Record<string, string>) {
    commit(update(ensureLoaded()));
  }

  return { draft: drafts[id] ?? "", setDrafts };
}
