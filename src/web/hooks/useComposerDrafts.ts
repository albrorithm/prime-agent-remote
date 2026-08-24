import { useState } from "react";

export const DRAFTS_KEY = "prime-web-drafts";
export const MAX_STORED_DRAFTS = 100;
export const MAX_DRAFT_LENGTH = 100_000;
export const MAX_STORED_DRAFT_BYTES = 1_000_000;

export function loadDrafts(): Record<string, string> {
  try {
    const stored = sessionStorage.getItem(DRAFTS_KEY) ?? "{}";
    if (stored.length > MAX_STORED_DRAFT_BYTES) return {};
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const drafts: Record<string, string> = {};
    for (const [agentId, draft] of Object.entries(value).slice(0, MAX_STORED_DRAFTS)) {
      if (!agentId || agentId.length > 256 || agentId === "__proto__" || typeof draft !== "string") continue;
      drafts[agentId] = draft.slice(0, MAX_DRAFT_LENGTH);
    }
    return drafts;
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

  function setDrafts(update: (current: Record<string, string>) => Record<string, string>) {
    setDraftsState((current) => {
      const next = update(current);
      try {
        sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable; drafts still work in memory.
      }
      return next;
    });
  }

  return { draft: drafts[id] ?? "", setDrafts };
}
