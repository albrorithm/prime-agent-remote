import type { AttentionKind, AttentionRequest } from "../protocol.js";

export const MAX_PUSH_AGENT_NAME_CHARS = 80;
export const PUSH_PAYLOAD_VERSION = 1;

/**
 * Why the phone is buzzing, by kind. Never why the *agent* is asking — that
 * lives in `AttentionRequest.title`, `detail`, and the option labels, none of
 * which may leave the gateway.
 */
const ATTENTION_REASONS: Record<AttentionKind, string> = {
  dialog: "Waiting on your decision",
  question: "Waiting on your answer",
  error: "Hit an error and stopped",
};

const FALLBACK_AGENT_NAME = "Prime Agent";

/**
 * What a locked phone is allowed to show.
 *
 * A notification is read by whoever is holding the device, and by anything
 * that mirrors a lock screen — a watch, a car display, a screen-shared
 * laptop. So this payload carries exactly two facts: which session wants
 * attention, and what kind of attention it wants. Prompt text, transcript
 * text, dialog titles, dialog messages, and option labels never appear here,
 * whatever the daemon put in them. `push-payload.test.ts` pins that.
 *
 * The ids are opaque handles for routing the tap, not content, and `badge` is
 * a count — the service worker needs it because it must set the app badge
 * itself while the app is closed, and it cannot compute one from nothing.
 */
export interface AttentionPushPayload {
  version: typeof PUSH_PAYLOAD_VERSION;
  /**
   * Who wants you. Not the session's display name — that falls back to the
   * first user message and then to the daemon's recap, both conversation text.
   * The caller passes `AgentSummary.notificationLabel`, which is drawn only
   * from a name a person typed or the session's directory.
   */
  title: string;
  /** What kind of attention, and nothing about its subject. */
  body: string;
  /**
   * The three attention kinds, plus the two ways a turn can end. The service
   * worker tags its notification by this, so a finished turn never replaces a
   * banner asking for an answer.
   */
  kind: AttentionKind | "complete" | "failed";
  agentId: string;
  attentionId: string;
  badge: number;
}

function agentTitle(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  if (!trimmed) return FALLBACK_AGENT_NAME;
  return trimmed.length > MAX_PUSH_AGENT_NAME_CHARS
    ? `${trimmed.slice(0, MAX_PUSH_AGENT_NAME_CHARS - 1)}…`
    : trimmed;
}

/**
 * What a finished turn is allowed to say.
 *
 * The same rule as everything else here: which session, and what kind of event.
 * "Finished" and "stopped with an error" are status words the gateway chose,
 * not anything the agent wrote, so nothing the model produced reaches a lock
 * screen through this either.
 */
const TURN_END_REASONS = {
  complete: "Finished and waiting on you",
  failed: "Stopped with an error",
} as const;

export function buildTurnEndPushPayload(
  agentId: string,
  agentName: string | undefined,
  outcome: keyof typeof TURN_END_REASONS,
  badge: number,
): AttentionPushPayload {
  return {
    version: PUSH_PAYLOAD_VERSION,
    title: agentTitle(agentName),
    body: TURN_END_REASONS[outcome],
    kind: outcome,
    agentId,
    /* No attention request exists for a finished turn, so this carries the
       agent's id: it is what `notificationclick` routes on, and an empty string
       would open the app to nothing in particular. */
    attentionId: agentId,
    badge: Number.isSafeInteger(badge) && badge > 0 ? badge : 0,
  };
}

export function buildAttentionPushPayload(
  attention: AttentionRequest,
  agentName: string | undefined,
  badge: number,
): AttentionPushPayload {
  return {
    version: PUSH_PAYLOAD_VERSION,
    title: agentTitle(agentName),
    body: ATTENTION_REASONS[attention.kind],
    kind: attention.kind,
    agentId: attention.agentId,
    attentionId: attention.id,
    badge: Number.isSafeInteger(badge) && badge > 0 ? badge : 0,
  };
}
