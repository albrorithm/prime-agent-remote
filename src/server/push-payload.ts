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
  kind: AttentionKind;
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
