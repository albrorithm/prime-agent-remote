import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Pinning and archiving, as a property of this device rather than of the
 * session.
 *
 * Nothing here reaches the gateway. A pin says "keep this at the top of my
 * list" and an archive says "stop showing me this one"; neither is a fact
 * about the agent, and neither may change what Prime is doing. The daemon
 * owns the lifecycle, and this file must never look like a second opinion on
 * it: an archived session that is working keeps working, keeps its status
 * light, and keeps arriving at the top of the attention filter.
 */
export const SESSION_ORGANIZATION_STORAGE_KEY = "prime.session-organization";

/**
 * Bumped only when the stored shape changes in a way an older reader would
 * misread. A version it does not recognise is discarded rather than guessed
 * at, which costs the user their pins once and never corrupts the list.
 */
export const SESSION_ORGANIZATION_SCHEMA_VERSION = 1;

/**
 * Both sets are bounded rather than pruned against the catalog. Pruning needs
 * a moment when the catalog is known to be complete, and there is no such
 * moment: the catalog arrives over a socket, can be empty while reconnecting,
 * and a prune run against that empty list would silently forget every pin the
 * user has. A bound needs no such certainty. Oldest entries fall off first, so
 * the ids that survive are the ones touched most recently.
 */
export const MAX_ORGANIZED_SESSION_IDS = 200;

export interface SessionOrganization {
  pinned: ReadonlySet<string>;
  archived: ReadonlySet<string>;
  togglePin: (id: string) => void;
  toggleArchive: (id: string) => void;
}

interface StoredOrganization {
  version: number;
  pinned: string[];
  archived: string[];
}

interface OrganizationState {
  pinned: string[];
  archived: string[];
}

const EMPTY: OrganizationState = { pinned: [], archived: [] };

function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item) continue;
    seen.add(item);
  }
  return bound([...seen]);
}

/** Keep the newest ids. Additions append, so the front of the list is oldest. */
function bound(ids: string[]): string[] {
  return ids.length > MAX_ORGANIZED_SESSION_IDS ? ids.slice(ids.length - MAX_ORGANIZED_SESSION_IDS) : ids;
}

export function loadSessionOrganization(): OrganizationState {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_ORGANIZATION_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const stored = parsed as Partial<StoredOrganization>;
    if (stored.version !== SESSION_ORGANIZATION_SCHEMA_VERSION) return EMPTY;
    return { pinned: readIdList(stored.pinned), archived: readIdList(stored.archived) };
  } catch {
    // Storage can be absent, disabled (private browsing, a locked-down
    // WebView), or full, and the value can be anything a previous build or a
    // hand edit left there. None of that is worth a broken session list.
    return EMPTY;
  }
}

function persist(state: OrganizationState): void {
  try {
    const payload: StoredOrganization = {
      version: SESSION_ORGANIZATION_SCHEMA_VERSION,
      pinned: state.pinned,
      archived: state.archived,
    };
    globalThis.localStorage?.setItem(SESSION_ORGANIZATION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // A write that fails costs this device the memory of a pin, which is a
    // smaller loss than a toggle that throws out of a click handler.
  }
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : bound([...ids, id]);
}

export function useSessionOrganization(): SessionOrganization {
  const [state, setState] = useState<OrganizationState>(loadSessionOrganization);
  // The first render's value came from storage; writing it straight back would
  // be a pointless write on every mount, and would overwrite a newer value
  // another tab wrote between our read and our first paint.
  const loaded = useRef(false);

  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    persist(state);
  }, [state]);

  const togglePin = useCallback((id: string) => {
    setState((current) => {
      const pinned = toggleId(current.pinned, id);
      // Pinning something that is hidden would put it at the top of a list it
      // is not in. The pin is the more specific wish, so it wins.
      const archived = pinned.includes(id) ? current.archived.filter((item) => item !== id) : current.archived;
      return { pinned, archived };
    });
  }, []);

  const toggleArchive = useCallback((id: string) => {
    setState((current) => {
      const archived = toggleId(current.archived, id);
      // Same rule from the other side: hiding a session drops its pin rather
      // than leaving a pin that points at nothing on screen.
      const pinned = archived.includes(id) ? current.pinned.filter((item) => item !== id) : current.pinned;
      return { pinned, archived };
    });
  }, []);

  const pinned = useMemo(() => new Set(state.pinned), [state.pinned]);
  const archived = useMemo(() => new Set(state.archived), [state.archived]);

  return { pinned, archived, togglePin, toggleArchive };
}
