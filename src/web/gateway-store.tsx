import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  AgentSnapshot,
  AgentSummary,
  BootstrapResponse,
  CatalogSnapshot,
  EventEnvelope,
  GatewayEvent,
  ImageAttachmentInput,
  ServerFrame,
  StreamCursor,
  TranscriptMessage,
  WebPushAvailability,
  MutationAccepted,
  SlashCommandCatalog,
  SlashCommandResult,
} from "../protocol";
import { attentionAgentCount, PROTOCOL_VERSION, readPairingFragment, serverFrameSchema } from "../protocol";
import * as api from "./api";
import { ApiError, humanizeError } from "./api";
import { deviceLabel } from "./device-label";
import { loadSettings } from "./settings";
import { useAppBadge } from "./hooks/useAppBadge";
import { reclaimPushSubscription, revokePushLocally } from "./push";
import type { PreparedImage } from "./image-attachments";

export type ConnectionPhase = "checking" | "connecting" | "live" | "offline" | "replaying";

export interface PendingMessage {
  id: string;
  text: string;
  createdAt: string;
  knownUserMessageIds: string[];
  attachments?: Array<{
    mimeType: PreparedImage["mimeType"];
    previewUrl?: string;
    ownsPreviewUrl?: boolean;
  }>;
}

const SNAPSHOT_CAP = 24;
const ERROR_TTL_MS = 6000;
export const SOCKET_PING_INTERVAL_MS = 25_000;
export const SOCKET_PONG_TIMEOUT_MS = 10_000;
/**
 * The deadline for the ping sent the moment the app comes back to the front.
 *
 * A phone that has been asleep hands back a socket reporting OPEN that is
 * already dead: nothing closed it, because nothing tried to use it. The steady
 * ping loop finds that out eventually — a ping interval plus a pong timeout
 * later, most of a minute — and until it does, the transcript on screen is
 * stale and looks live. That is the most common interaction there is: unlock
 * the phone, read what the agent did. So the wake path asks at once, and asks
 * on a much shorter deadline, because a socket that is really there answers in
 * milliseconds over any link worth keeping.
 */
export const SOCKET_PROBE_TIMEOUT_MS = 3_000;
/**
 * Two wakes this close together are one wake. iOS backgrounds the page for its
 * own surfaces — the photo picker, the share sheet — and hands it straight
 * back, which is a visibility change the user never made.
 */
const PROBE_COALESCE_MS = 1_000;
/** One retry, then believe it. See the stream_gone handler. */
const STREAM_GONE_RETRY_LIMIT = 1;

export const SOCKET_OPEN_TIMEOUT_MS = 12_000;

export function imageInputsForRequest(images: PreparedImage[]): ImageAttachmentInput[] {
  return images.map(({ type, mimeType, data }) => ({ type, mimeType, data }));
}

function pendingAttachment(image: PreparedImage): NonNullable<PendingMessage["attachments"]>[number] {
  if (typeof URL.createObjectURL !== "function") return { mimeType: image.mimeType };
  try {
    const preview = image.previewBlob.slice(0, image.previewBlob.size, image.previewBlob.type);
    return { mimeType: image.mimeType, previewUrl: URL.createObjectURL(preview), ownsPreviewUrl: true };
  } catch {
    return { mimeType: image.mimeType };
  }
}

export function reconcilePending(pending: PendingMessage[], messages: TranscriptMessage[]): PendingMessage[] {
  const claimedMessageIds = new Set<string>();
  const remaining: PendingMessage[] = [];
  for (const item of pending) {
    const known = new Set(item.knownUserMessageIds);
    const match = messages.find((message) => {
      if (message.role !== "user" || message.text !== item.text || known.has(message.id) || claimedMessageIds.has(message.id)) {
        return false;
      }
      const pendingMimes = (item.attachments ?? []).map((attachment) => attachment.mimeType).sort();
      const messageMimes = (message.attachments ?? []).map((attachment) => attachment.mimeType).sort();
      return pendingMimes.length === messageMimes.length
        && pendingMimes.every((mimeType, index) => mimeType === messageMimes[index]);
    });
    if (match) claimedMessageIds.add(match.id);
    else remaining.push(item);
  }
  if (!claimedMessageIds.size) return remaining;
  // Remember consumed echoes on survivors. Otherwise the next snapshot could use
  // the same echo to clear a second identical optimistic message.
  return remaining.map((item) => ({
    ...item,
    knownUserMessageIds: [...new Set([...item.knownUserMessageIds, ...claimedMessageIds])],
  }));
}

function clearTranscriptError(errors: Record<string, string>, agentId: string): Record<string, string> {
  if (!(agentId in errors)) return errors;
  const next = { ...errors };
  delete next[agentId];
  return next;
}

/* A caller-side abort is the session moving on, not a failure worth showing.
   Everything else is something the user needs told, with the timeout named
   rather than left as a silent spinner. */
export function transcriptErrorMessage(error: unknown): string | null {
  if (error instanceof DOMException && error.name === "AbortError") return null;
  if (error instanceof api.ApiError) {
    if (error.status === 408) return "Loading the transcript timed out.";
    return error.message;
  }
  return "Could not reach the gateway.";
}

function pruneSnapshots(snapshots: Record<string, AgentSnapshot>, keep: string | null): Record<string, AgentSnapshot> {
  const ids = Object.keys(snapshots);
  if (ids.length <= SNAPSHOT_CAP) return snapshots;
  const evictable = ids.filter((id) => id !== keep).slice(0, ids.length - SNAPSHOT_CAP);
  if (!evictable.length) return snapshots;
  const next = { ...snapshots };
  for (const id of evictable) delete next[id];
  return next;
}

interface State {
  authRequired: boolean;
  connection: ConnectionPhase;
  csrfToken: string;
  backend: "demo" | "prime" | null;
  /** Whether this gateway can push at all. Null until the first bootstrap. */
  push: WebPushAvailability | null;
  catalog: CatalogSnapshot;
  snapshots: Record<string, AgentSnapshot>;
  /* Why a transcript has no snapshot, when the reason is not "still loading".
     Without this the panel cannot tell a slow load from a failed one, and a
     clean 15s timeout looks exactly like the permanent deadlock we just fixed. */
  transcriptErrors: Record<string, string>;
  // Agent ids whose stream was explicitly declared gone (a "stream_gone" detach).
  // Distinct from "no snapshot yet": a late HTTP response for one of these must
  // never resurrect it, whereas an agent that simply hasn't loaded yet should
  // still accept its HTTP snapshot even if unrelated realtime traffic touched
  // the stream while the fetch was in flight.
  goneAgentIds: Set<string>;
  pending: Record<string, PendingMessage[]>;
  selectedAgentId: string | null;
  error: string | null;
  // True once the socket has gone offline at least once this app lifetime, so
  // the connection banner can tell a fresh cold start ("Connecting…") apart
  // from a drop-and-retry ("Reconnecting…"). Reset on a fresh auth cycle.
  hasReconnected: boolean;
  // True once a bootstrap has ever succeeded this app lifetime. Survives the
  // `auth_required` reset (unlike the rest of state) so Login can tell "you
  // were paired and your session expired" apart from a true first-time pair.
  hadSession: boolean;
  /**
   * Why a pairing link failed, if one did. Survives the reset that shows the
   * pairing screen, because that screen is all there is to say it on: the
   * error banner is not rendered there.
   */
  linkError: string | null;
}

/**
 * A notification tap opens `/?agent=<id>`. The id is read once per app launch
 * and stripped from the URL immediately, so a reload or a shared link does not
 * keep re-selecting a session the user has since navigated away from.
 */
export function takeRequestedAgentId(): string | null {
  try {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("agent");
    if (!requested) return null;
    url.searchParams.delete("agent");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return requested;
  } catch {
    return null;
  }
}

/**
 * The setup token a pairing link carries, read once per app launch and removed
 * from the URL in the same breath.
 *
 * Stripped before anything is sent anywhere. A fragment never reaches a server
 * on its own, but it does sit in the address bar, in a screenshot, and in
 * whatever the browser restores on a back navigation, and none of those are
 * places for a credential to stay.
 */
export function takePairingToken(): string | null {
  try {
    const token = readPairingFragment(window.location.hash);
    if (!token) return null;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    return token;
  } catch {
    return null;
  }
}

type Action =
  | { type: "bootstrap"; value: BootstrapResponse; requestedAgentId?: string | null }
  | { type: "auth_required"; signedOut?: true; linkError?: string }
  | { type: "connection"; value: ConnectionPhase }
  | { type: "catalog"; value: CatalogSnapshot }
  | { type: "snapshot"; value: AgentSnapshot; source?: "http" | "ws"; allowEqualRevision?: boolean }
  | { type: "event"; value: EventEnvelope }
  | { type: "agent_revision"; agentId: string; revision: number }
  | { type: "pending_add"; agentId: string; value: PendingMessage }
  | { type: "pending_remove"; agentId: string; id: string }
  | { type: "evict_snapshot"; agentId: string }
  | { type: "transcript_error"; agentId: string; message: string | null }
  | { type: "select"; value: string | null }
  | { type: "error"; value: string | null };

const emptyCatalog: CatalogSnapshot = { revision: 0, agents: [] };
const initialState: State = {
  authRequired: false,
  connection: "checking",
  csrfToken: "",
  backend: null,
  push: null,
  catalog: emptyCatalog,
  snapshots: {},
  transcriptErrors: {},
  goneAgentIds: new Set(),
  pending: {},
  selectedAgentId: null,
  error: null,
  hasReconnected: false,
  hadSession: false,
  linkError: null,
};

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((value) => value.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

export function applyGatewayEvent(snapshot: AgentSnapshot, event: GatewayEvent): AgentSnapshot {
  switch (event.kind) {
    case "agent.replaced":
      return event.payload.revision < snapshot.revision ? snapshot : event.payload;
    case "agent.message_added":
    case "agent.message_updated":
      return { ...snapshot, messages: upsertById(snapshot.messages, event.payload) };
    case "agent.attention_added":
      return { ...snapshot, attention: upsertById(snapshot.attention, event.payload) };
    case "agent.attention_resolved":
      return { ...snapshot, attention: snapshot.attention.filter((item) => item.id !== event.payload.id) };
    case "catalog.replaced":
      return snapshot;
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "bootstrap": {
      const catalog = action.value.catalog.revision < state.catalog.revision
        ? state.catalog
        : action.value.catalog;
      const first = catalog.agents.find((agent) => agent.parentId === null)?.id ?? null;
      // A notification tap outranks a preserved selection: the user just told
      // us which session they came here for.
      const requested = action.requestedAgentId
        && catalog.agents.some((agent) => agent.id === action.requestedAgentId)
        ? action.requestedAgentId
        : null;
      return {
        ...state,
        authRequired: false,
        connection: "connecting",
        csrfToken: action.value.csrfToken,
        backend: action.value.backend,
        push: action.value.push,
        catalog,
        selectedAgentId: requested
          ?? (state.selectedAgentId
            && catalog.agents.some((agent) => agent.id === state.selectedAgentId)
            ? state.selectedAgentId
            : first),
        error: null,
        hadSession: true,
      };
    }
    case "auth_required":
      return {
        ...initialState,
        authRequired: true,
        connection: "offline",
        // A deliberate sign-out is not an expiry, so Login greets it as a fresh pair.
        hadSession: action.signedOut ? false : state.hadSession,
        linkError: action.linkError ?? null,
      };
    case "connection":
      return {
        ...state,
        connection: action.value,
        hasReconnected: state.hasReconnected || action.value === "offline",
      };
    case "catalog":
      if (action.value.revision < state.catalog.revision) return state;
      return { ...state, catalog: action.value };
    case "snapshot": {
      const current = state.snapshots[action.value.agentId];
      // A stream that was explicitly declared gone must never be resurrected by a
      // late HTTP response, even though there is no current snapshot to protect.
      // ...unless the catalog still lists it, in which case it was never
      // deleted and refusing the snapshot leaves the transcript spinning with
      // nothing able to clear the flag.
      if (!current
        && action.source === "http"
        && state.goneAgentIds.has(action.value.agentId)
        && !state.catalog.agents.some((agent) => agent.id === action.value.agentId)) return state;
      if (current && action.value.revision < current.revision) return state;
      if (current
        && action.value.revision === current.revision
        && action.source === "http"
        && action.allowEqualRevision === false) return state;
      let goneAgentIds = state.goneAgentIds;
      if (goneAgentIds.has(action.value.agentId)) {
        goneAgentIds = new Set(goneAgentIds);
        goneAgentIds.delete(action.value.agentId);
      }
      return {
        ...state,
        snapshots: pruneSnapshots(
          { ...state.snapshots, [action.value.agentId]: action.value },
          state.selectedAgentId,
        ),
        // The transcript arrived, so whatever went wrong last time no longer has
        // anything to say.
        transcriptErrors: clearTranscriptError(state.transcriptErrors, action.value.agentId),
        goneAgentIds,
        pending: {
          ...state.pending,
          [action.value.agentId]: reconcilePending(state.pending[action.value.agentId] ?? [], action.value.messages),
        },
      };
    }
    case "transcript_error": {
      if (action.message === null) {
        return { ...state, transcriptErrors: clearTranscriptError(state.transcriptErrors, action.agentId) };
      }
      return { ...state, transcriptErrors: { ...state.transcriptErrors, [action.agentId]: action.message } };
    }
    case "event": {
      if (action.value.event.kind === "catalog.replaced") {
        const catalog = action.value.event.payload;
        if (catalog.revision < state.catalog.revision) return state;
        // A session can leave the catalog while it is the one on screen —
        // deleted from here, or ended from anywhere else. Falling back to the
        // first root keeps the app pointed at something real rather than at a
        // selection the catalog no longer contains.
        const stillListed = state.selectedAgentId !== null
          && catalog.agents.some((agent) => agent.id === state.selectedAgentId);
        return {
          ...state,
          catalog,
          selectedAgentId: stillListed
            ? state.selectedAgentId
            : catalog.agents.find((agent) => agent.parentId === null)?.id ?? null,
        };
      }
      const agentId = action.value.streamId.startsWith("agent:") ? action.value.streamId.slice(6) : null;
      if (!agentId) return state;
      const current = state.snapshots[agentId];
      if (!current) return state;
      const updated = applyGatewayEvent(current, action.value.event);
      return {
        ...state,
        snapshots: { ...state.snapshots, [agentId]: updated },
        pending: {
          ...state.pending,
          [agentId]: reconcilePending(state.pending[agentId] ?? [], updated.messages),
        },
      };
    }
    case "agent_revision": {
      const current = state.snapshots[action.agentId];
      if (!current) return state;
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.agentId]: { ...current, revision: Math.max(current.revision, action.revision) },
        },
      };
    }
    case "pending_add": {
      const current = state.pending[action.agentId] ?? [];
      return { ...state, pending: { ...state.pending, [action.agentId]: [...current, action.value] } };
    }
    case "pending_remove": {
      const current = state.pending[action.agentId];
      if (!current) return state;
      return {
        ...state,
        pending: { ...state.pending, [action.agentId]: current.filter((item) => item.id !== action.id) },
      };
    }
    case "evict_snapshot": {
      const goneAgentIds = new Set(state.goneAgentIds);
      goneAgentIds.add(action.agentId);
      if (!(action.agentId in state.snapshots)) return { ...state, goneAgentIds };
      const snapshots = { ...state.snapshots };
      delete snapshots[action.agentId];
      return { ...state, snapshots, goneAgentIds };
    }
    case "select":
      return { ...state, selectedAgentId: action.value };
    case "error":
      return { ...state, error: action.value };
  }
}

interface GatewayContextValue extends State {
  selectedAgent: AgentSummary | null;
  selectedSnapshot: AgentSnapshot | null;
  pendingMessages: PendingMessage[];
  /** Agents that are waiting on the user, app-wide. Drives every badge. */
  attentionCount: number;
  pair: (token: string) => Promise<void>;
  selectAgent: (id: string) => Promise<void>;
  createSession: (cwd: string, name?: string, requestId?: string) => Promise<string>;
  send: (text: string, images?: PreparedImage[], requestId?: string) => Promise<void>;
  loadSlashCommands: (agentId: string) => Promise<SlashCommandCatalog>;
  runSlashCommand: (name: string, args: string, requestId?: string) => Promise<SlashCommandResult>;
  abort: (agentId?: string) => Promise<void>;
  rename: (agentId: string, name: string) => Promise<void>;
  stop: (agentId: string) => Promise<void>;
  deleteSession: (agentId: string, confirmName: string) => Promise<void>;
  respond: (attentionId: string, revision: number, optionId: string) => Promise<void>;
  signOut: () => Promise<void>;
  reconnect: () => void;
  /** Try a failed transcript again, from the panel that is showing the failure. */
  retryTranscript: (agentId: string) => Promise<void>;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

function socketUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1/events`;
}

/** What an HTTP snapshot fetch yields: the snapshot, and whether the reducer may accept it at an unchanged revision. */
interface LoadedAgent {
  snapshot: AgentSnapshot;
  /** No realtime update touched this stream during the fetch, so an
      equal-revision snapshot is still the newest thing known. */
  allowEqualRevision: boolean;
}

export function GatewayProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pendingPreviewUrlsRef = useRef(new Set<string>());
  const requestBaselinesRef = useRef(new Map<string, string[]>());
  const createRequestIdsRef = useRef(new Map<string, string>());
  const stateRef = useRef(state);
  /* A stream that answered "gone" while its agent was still listed, and how
     many times. One retry is enough against a gateway that warms the stream
     before answering; the cap is what stops an attach/gone ping-pong if some
     future server disagrees. */
  const streamGoneRetries = useRef(new Map<string, number>());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const retryCount = useRef(0);
  const cursors = useRef(new Map<string, StreamCursor>());
  const realtimeVersions = useRef(new Map<string, number>());
  const subscriptions = useRef(new Set<string>(["catalog"]));
  const replayingStreams = useRef(new Set<string>());
  const manuallyClosed = useRef(false);
  const errorTimer = useRef<number | null>(null);
  const socketGeneration = useRef(0);
  // Set by the live socket, so the wake handler can ping without reaching into
  // `connect`'s closure for the pong timer that ping arms.
  const probeRef = useRef<(() => void) | null>(null);
  const lastProbeAt = useRef(0);
  const initializationGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const lifecycleAbort = useRef<AbortController | null>(null);
  const selectionGeneration = useRef(0);
  // Bumped on every openAgent() entry, so a call superseded by a newer one
  // (two sessions opened back to back, before the first's fetch resolves) can
  // tell it no longer owns the trailing subscription cleanup below — without
  // this, a stale call's cleanup can detach the *newer* call's just-attached
  // stream, because it only sees "no snapshot yet" and not "superseded".
  const openAgentGeneration = useRef(0);
  const socketRetryBlocked = useRef(false);
  // Holds the latest `initialize` so the socket-retry scheduler (defined before
  // `initialize` exists) can call it without a circular useCallback dependency.
  const initializeRef = useRef<() => Promise<void>>(async () => {});
  // `undefined` until the launch URL has been read; null once consumed. Set to
  // null the instant a bootstrap succeeds, so the deep link is honored exactly
  // once per app launch — not once per successful bootstrap, which would
  // reapply it on every reconnect. A bootstrap that never succeeds leaves this
  // `undefined`, so a later attempt can still consume it.
  const requestedAgentId = useRef<string | null | undefined>(undefined);
  /* Read during the first render rather than in an effect, so the token is out
     of the URL before the app has done anything at all. `undefined` means not
     yet read; null means read, and spent or absent. */
  const pairingLinkToken = useRef<string | null | undefined>(undefined);
  if (pairingLinkToken.current === undefined) pairingLinkToken.current = takePairingToken();
  // The CSRF token of the session this device last claimed its push
  // subscription for. Changes exactly when the session does.
  const pushClaimedFor = useRef<string | null>(null);
  /**
   * Guards the one automatic resume per initialize attempt. Without it a
   * revoked credential and a 401 would call each other forever.
   */
  const resumeAttempted = useRef(false);
  stateRef.current = state;

  useEffect(() => {
    const next = new Set(
      Object.values(state.pending)
        .flat()
        .flatMap((message) => (message.attachments ?? [])
          .filter((attachment) => attachment.ownsPreviewUrl && attachment.previewUrl)
          .map((attachment) => attachment.previewUrl!)),
    );
    for (const url of pendingPreviewUrlsRef.current) {
      if (!next.has(url)) URL.revokeObjectURL(url);
    }
    pendingPreviewUrlsRef.current = next;
  }, [state.pending]);

  useEffect(() => () => {
    for (const url of pendingPreviewUrlsRef.current) URL.revokeObjectURL(url);
    pendingPreviewUrlsRef.current.clear();
  }, []);

  const showError = useCallback((message: string | null) => {
    if (errorTimer.current != null) window.clearTimeout(errorTimer.current);
    errorTimer.current = null;
    dispatch({ type: "error", value: message });
    if (message != null) {
      errorTimer.current = window.setTimeout(() => {
        errorTimer.current = null;
        dispatch({ type: "error", value: null });
      }, ERROR_TTL_MS);
    }
  }, []);

  const showPersistentError = useCallback((message: string) => {
    if (errorTimer.current != null) window.clearTimeout(errorTimer.current);
    errorTimer.current = null;
    dispatch({ type: "error", value: message });
  }, []);

  const markRealtimeUpdate = useCallback((streamId: string) => {
    // Anything delivered on the stream means the attach took.
    streamGoneRetries.current.delete(streamId);
    realtimeVersions.current.set(streamId, (realtimeVersions.current.get(streamId) ?? 0) + 1);
  }, []);

  const loadAgentHttp = useCallback(async (agentId: string, options?: api.ApiRequestOptions): Promise<LoadedAgent> => {
    const streamId = `agent:${agentId}`;
    const baseline = realtimeVersions.current.get(streamId) ?? 0;
    const snapshot = await api.loadAgent(agentId, options);
    return {
      snapshot,
      allowEqualRevision: (realtimeVersions.current.get(streamId) ?? 0) === baseline,
    };
  }, []);

  /** Hand a fetched snapshot to the reducer. Each caller's generation guard differs; this part never did. */
  const dispatchLoadedSnapshot = useCallback((loaded: LoadedAgent) => {
    dispatch({
      type: "snapshot",
      value: loaded.snapshot,
      source: "http",
      allowEqualRevision: loaded.allowEqualRevision,
    });
  }, []);

  const updateSocketPhase = useCallback(() => {
    if (replayingStreams.current.size) dispatch({ type: "connection", value: "replaying" });
    else if (socketRef.current?.readyState === WebSocket.OPEN) dispatch({ type: "connection", value: "live" });
  }, []);

  const detach = useCallback((streamId: string) => {
    subscriptions.current.delete(streamId);
    cursors.current.delete(streamId);
    // Tombstone the stream instead of deleting its version. Any HTTP snapshot
    // already in flight must observe that the subscription was detached.
    markRealtimeUpdate(streamId);
    replayingStreams.current.delete(streamId);
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "detach", version: PROTOCOL_VERSION, streamId }));
    }
    updateSocketPhase();
  }, [markRealtimeUpdate, updateSocketPhase]);

  const attach = useCallback((streamId: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "attach",
        version: PROTOCOL_VERSION,
        streamId,
        since: cursors.current.get(streamId) ?? null,
      }),
    );
  }, []);

  const resetForUnauthorized = useCallback((signedOut?: true, linkError?: string) => {
    initializationGeneration.current += 1;
    sessionGeneration.current += 1;
    lifecycleAbort.current?.abort();
    lifecycleAbort.current = null;
    selectionGeneration.current += 1;
    requestBaselinesRef.current.clear();
    createRequestIdsRef.current.clear();
    subscriptions.current = new Set(["catalog"]);
    cursors.current.clear();
    realtimeVersions.current.clear();
    replayingStreams.current.clear();
    socketRetryBlocked.current = false;
    retryCount.current = 0;
    if (errorTimer.current != null) window.clearTimeout(errorTimer.current);
    errorTimer.current = null;
    if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    socketGeneration.current += 1;
    socket?.close();
    dispatch({
      type: "auth_required",
      ...(signedOut ? { signedOut } : {}),
      ...(linkError ? { linkError } : {}),
    });
  }, []);

  const connect = useCallback(() => {
    if (manuallyClosed.current || socketRetryBlocked.current) return;
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
    if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    dispatch({ type: "connection", value: "connecting" });
    const generation = ++socketGeneration.current;
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch (error) {
      dispatch({ type: "connection", value: "offline" });
      showError(humanizeError(error, "Could not open the realtime connection"));
      const attempt = retryCount.current++;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      // After 2+ consecutive failures, re-run the HTTP bootstrap instead of just
      // retrying the socket — that is what surfaces a 401 (session expired) and
      // routes to pairing instead of spinning forever on a dead connection.
      reconnectTimer.current = window.setTimeout(() => {
        if (attempt + 1 >= 2) void initializeRef.current();
        else connect();
      }, delay);
      return;
    }
    socketRef.current = socket;
    let openTimer: number | null = null;
    let pingTimer: number | null = null;
    let pongTimer: number | null = null;
    const isCurrent = () => generation === socketGeneration.current && socketRef.current === socket;
    /* One ping, and a deadline for its pong. The steady interval below passes
       the ordinary timeout and the wake probe passes a much shorter one, but
       both end the same way: silence past the deadline closes the socket, and
       the close handler already there is what reconnects. The probe adds a
       trigger, not a second recovery path. */
    const ping = (timeoutMs: number) => {
      if (!isCurrent() || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "ping", version: PROTOCOL_VERSION }));
      if (pongTimer != null) window.clearTimeout(pongTimer);
      pongTimer = window.setTimeout(() => {
        pongTimer = null;
        if (isCurrent()) socket.close();
      }, timeoutMs);
    };
    const probe = () => ping(SOCKET_PROBE_TIMEOUT_MS);
    const clearWatchdog = () => {
      if (openTimer != null) window.clearTimeout(openTimer);
      if (pingTimer != null) window.clearInterval(pingTimer);
      if (pongTimer != null) window.clearTimeout(pongTimer);
      openTimer = null;
      pingTimer = null;
      pongTimer = null;
      // Only if this socket is still the one publishing it: a newer socket has
      // already replaced the reference, and clearing it would silence the wake
      // probe for the connection that is actually live.
      if (probeRef.current === probe) probeRef.current = null;
    };

    socket.addEventListener("open", () => {
      if (!isCurrent()) return;
      if (openTimer != null) window.clearTimeout(openTimer);
      openTimer = null;
      retryCount.current = 0;
      updateSocketPhase();
      for (const streamId of subscriptions.current) attach(streamId);
      probeRef.current = probe;
      pingTimer = window.setInterval(() => ping(SOCKET_PONG_TIMEOUT_MS), SOCKET_PING_INTERVAL_MS);
    });
    socket.addEventListener("message", (message) => {
      if (!isCurrent()) return;
      let input: unknown;
      try {
        input = JSON.parse(String(message.data));
      } catch {
        showError("The server sent invalid realtime data");
        socket.close();
        return;
      }
      const parsed = serverFrameSchema.safeParse(input);
      if (!parsed.success) {
        showError("The server sent invalid realtime data");
        socket.close();
        return;
      }
      const frame = parsed.data as ServerFrame;
      if (frame.type === "pong") {
        if (pongTimer != null) window.clearTimeout(pongTimer);
        pongTimer = null;
        return;
      }
      if (frame.type === "detached") {
        replayingStreams.current.delete(frame.streamId);
        if (frame.reason === "server_shutdown") {
          // Keep subscriptions. A new server epoch will replace their cursors.
          markRealtimeUpdate(frame.streamId);
          dispatch({ type: "connection", value: "offline" });
          socket.close(1000, "Server restarting");
          return;
        }
        if (frame.reason === "stream_gone") {
          const agentId = frame.streamId.startsWith("agent:") ? frame.streamId.slice(6) : null;
          // "Gone" used to arrive for an agent that was merely not registered
          // yet, and evicting on it is unrecoverable: the HTTP snapshot is then
          // refused, and only a WebSocket snapshot clears that — which needs the
          // attach this just threw away. The gateway now warms a stream before
          // answering, so this should not happen; catalog membership is the
          // second opinion, because a deleted agent leaves the catalog.
          const stillListed = agentId !== null
            && stateRef.current.catalog.agents.some((agent) => agent.id === agentId);
          const attempts = streamGoneRetries.current.get(frame.streamId) ?? 0;
          if (stillListed && attempts < STREAM_GONE_RETRY_LIMIT) {
            streamGoneRetries.current.set(frame.streamId, attempts + 1);
            cursors.current.delete(frame.streamId);
            attach(frame.streamId);
            return;
          }
          streamGoneRetries.current.delete(frame.streamId);
          detach(frame.streamId);
          if (agentId) dispatch({ type: "evict_snapshot", agentId });
          return;
        }
        // A lagged or invalid cursor must retry from a full snapshot. Reusing the
        // rejected cursor would create an attach/detach loop.
        cursors.current.delete(frame.streamId);
        replayingStreams.current.add(frame.streamId);
        dispatch({ type: "connection", value: "replaying" });
        attach(frame.streamId);
        return;
      }
      if (frame.type === "snapshot") {
        cursors.current.set(frame.streamId, frame.cursor);
        replayingStreams.current.delete(frame.streamId);
        markRealtimeUpdate(frame.streamId);
        if (frame.streamId === "catalog") dispatch({ type: "catalog", value: frame.snapshot as CatalogSnapshot });
        else dispatch({ type: "snapshot", value: frame.snapshot as AgentSnapshot, source: "ws" });
        updateSocketPhase();
        return;
      }
      const events = frame.type === "replay" ? frame.events : [frame.envelope];
      if (frame.type === "replay") {
        replayingStreams.current.add(frame.streamId);
        dispatch({ type: "connection", value: "replaying" });
      }
      for (const envelope of events) {
        const cursor = cursors.current.get(envelope.streamId);
        if (cursor?.epoch === envelope.epoch && envelope.seq <= cursor.seq) continue;
        if (cursor?.epoch === envelope.epoch && envelope.seq !== cursor.seq + 1) {
          replayingStreams.current.add(envelope.streamId);
          dispatch({ type: "connection", value: "replaying" });
          attach(envelope.streamId);
          return;
        }
        cursors.current.set(envelope.streamId, { epoch: envelope.epoch, seq: envelope.seq });
        markRealtimeUpdate(envelope.streamId);
        dispatch({ type: "event", value: envelope });
      }
      if (frame.type === "replay") {
        cursors.current.set(frame.streamId, frame.cursor);
        replayingStreams.current.delete(frame.streamId);
        updateSocketPhase();
      }
    });
    socket.addEventListener("close", (event) => {
      clearWatchdog();
      if (!isCurrent()) return;
      socketRef.current = null;
      replayingStreams.current.clear();
      const closeEvent = event as CloseEvent;
      // 1008 also carries "Invalid protocol frame", which must keep retrying,
      // so the reason is load-bearing. These are the gateway's three auth-loss
      // closes, and for a revoked device this frame is the only notice it gets.
      if (closeEvent.code === 1008 && /session expired|signed out|device revoked/i.test(closeEvent.reason)) {
        resetForUnauthorized();
        return;
      }
      if (manuallyClosed.current || stateRef.current.authRequired) return;
      dispatch({ type: "connection", value: "offline" });
      if (closeEvent.code === 1009) {
        socketRetryBlocked.current = true;
        showPersistentError("Realtime data is too large. Reduce this session's transcript, then retry.");
        return;
      }
      const attempt = retryCount.current++;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      reconnectTimer.current = window.setTimeout(() => {
        if (attempt + 1 >= 2) void initializeRef.current();
        else connect();
      }, delay);
    });
    openTimer = window.setTimeout(() => {
      if (!isCurrent() || socket.readyState !== WebSocket.CONNECTING) return;
      showError("Realtime connection timed out. Retrying…");
      socket.close();
    }, SOCKET_OPEN_TIMEOUT_MS);
  }, [attach, detach, markRealtimeUpdate, resetForUnauthorized, showError, showPersistentError, updateSocketPhase]);

  const initialize = useCallback(async () => {
    const generation = ++initializationGeneration.current;
    lifecycleAbort.current?.abort();
    const controller = new AbortController();
    lifecycleAbort.current = controller;
    // Realtime recovery must not wait for the HTTP bootstrap or root snapshot.
    connect();
    try {
      // ownsUnauthorized: the catch below answers a 401 by resuming from the
      // device credential, and it cannot do that if the central handler has
      // already run. resetForUnauthorized() bumps initializationGeneration and
      // aborts this very controller, synchronously, while this call is still
      // unwinding — so both guards in the catch would fire and return before
      // reaching the resume. That is what made every gateway restart ask for
      // the pairing token again, with the resume path sitting there unused.
      const value = await api.bootstrap({ signal: controller.signal, ownsUnauthorized: true });
      if (generation !== initializationGeneration.current || controller.signal.aborted) return;
      // Read-and-clear in one step: the ref is consumed for good the instant a
      // bootstrap succeeds, regardless of what happens afterward, so a later
      // re-initialize (socket backoff, online/visibilitychange, a manual
      // reconnect) never reapplies a notification tap the user has since
      // navigated away from. A local var carries the one value both the
      // dispatch and the `first` lookup below need — `requestedAgentId.current`
      // is already null by the time they run.
      const requested = requestedAgentId.current === undefined ? takeRequestedAgentId() : requestedAgentId.current;
      requestedAgentId.current = null;
      dispatch({ type: "bootstrap", value, requestedAgentId: requested });
      const first = value.catalog.agents.find((agent) => agent.id === requested)
        ?? value.catalog.agents.find((agent) => agent.parentId === null);
      if (first) {
        const streamId = `agent:${first.id}`;
        subscriptions.current.add(streamId);
        attach(streamId);
        try {
          const loaded = await loadAgentHttp(first.id, { signal: controller.signal });
          if (generation !== initializationGeneration.current || controller.signal.aborted) return;
          dispatchLoadedSnapshot(loaded);
        } catch (error) {
          if (generation !== initializationGeneration.current || controller.signal.aborted) return;
          // This is the path that produced the endless spinner: the agent is
          // selected, the snapshot never arrives, and there is no selection to
          // roll back to. Record the reason, then rethrow so the global error
          // and the offline phase still happen as before.
          const message = transcriptErrorMessage(error);
          if (message) dispatch({ type: "transcript_error", agentId: first.id, message });
          throw error;
        }
      }
      if (pushClaimedFor.current !== value.csrfToken) {
        pushClaimedFor.current = value.csrfToken;
        // Best-effort and silent: a device that cannot re-claim its
        // subscription still works, it just keeps its old session binding.
        /* Read straight from storage rather than through the settings context:
           this runs inside the connection callback, and a stale closure over a
           React value here would re-subscribe with whatever the preference was
           when the socket opened — silently switching it back. */
        void reclaimPushSubscription(value.push, value.csrfToken, loadSettings().turnEndNotifications)
          .catch(() => {});
      }
      // A working session means a later 401 (a restart, an expiry) is allowed
      // its own resume attempt.
      resumeAttempted.current = false;
      if (!socketRetryBlocked.current) showError(null);
      updateSocketPhase();
    } catch (error) {
      if (generation !== initializationGeneration.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        // A paired device can start a new session on its own, which is what
        // makes a gateway restart invisible here. Tried once per attempt: if
        // the credential is missing or revoked this 401s too, and falling
        // through to the pairing screen is the right answer.
        if (!resumeAttempted.current) {
          resumeAttempted.current = true;
          try {
            // Also ownsUnauthorized: a 401 here is the ordinary "this browser
            // has never paired" answer, and the line below is already the
            // reset. Letting the central handler fire as well would reset once
            // from inside this call and once after it.
            await api.resume({ ownsUnauthorized: true });
            void initializeRef.current();
            return;
          } catch {
            // No usable credential. Fall through to the link, then the screen.
          }
        }
        /* A link is spent once, whatever happens to it. A token that failed
           will fail again, and retrying it on every re-initialize would burn
           the five-per-minute pairing budget for the whole address — which
           behind `tailscale serve` is every device in the house. */
        const linkToken = pairingLinkToken.current;
        pairingLinkToken.current = null;
        if (linkToken) {
          try {
            await api.pair(linkToken, deviceLabel());
            void initializeRef.current();
            return;
          } catch (pairError) {
            // Say why on the pairing screen, which is what comes next.
            resetForUnauthorized(undefined, humanizeError(pairError, "That pairing link did not work"));
            return;
          }
        }
        resetForUnauthorized();
        return;
      }
      /* A failed bootstrap says nothing about the transport. "offline" is a
         claim only a re-attach can retract, so on an open socket it would leave
         a banner offering a Reconnect that tears down a healthy connection. */
      if (socketRef.current?.readyState === WebSocket.OPEN) updateSocketPhase();
      else dispatch({ type: "connection", value: "offline" });
      showError(humanizeError(error, "Could not start the app"));
    } finally {
      if (lifecycleAbort.current === controller) lifecycleAbort.current = null;
    }
  }, [attach, connect, dispatchLoadedSnapshot, loadAgentHttp, resetForUnauthorized, showError, updateSocketPhase]);

  // Written from an effect (not during render) so a discarded StrictMode /
  // concurrent render can never leave a stale `initialize` behind — the retry
  // timer that reads this only ever fires after commit anyway.
  useEffect(() => {
    initializeRef.current = initialize;
  }, [initialize]);

  useEffect(() => {
    manuallyClosed.current = false;
    const unsubscribeUnauthorized = api.onUnauthorized(resetForUnauthorized);
    void initialize();
    return () => {
      manuallyClosed.current = true;
      unsubscribeUnauthorized();
      initializationGeneration.current += 1;
      sessionGeneration.current += 1;
      lifecycleAbort.current?.abort();
      lifecycleAbort.current = null;
      selectionGeneration.current += 1;
      if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
      if (errorTimer.current != null) window.clearTimeout(errorTimer.current);
      reconnectTimer.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      socketGeneration.current += 1;
      socket?.close();
    };
  }, [initialize, resetForUnauthorized]);

  /* A link opened while the app is already open changes only the fragment, so
     the browser does not reload and the read during the first render never
     happens again. That is the ordinary case on a phone: the tab is already
     there, and the camera hands it a URL that differs by a fragment. Without
     this the user watches the pairing form do nothing while the token sits in
     the address bar. */
  useEffect(() => {
    const onHashChange = () => {
      const token = takePairingToken();
      if (!token) return;
      // Already paired: the link is redundant, and stripping it is the whole
      // job. Holding the token for some later 401 would spend a stale secret
      // hours after the person who scanned it walked away.
      if (!stateRef.current.authRequired) return;
      pairingLinkToken.current = token;
      void initializeRef.current();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const recover = () => {
      if (stateRef.current.authRequired || socketRetryBlocked.current) return;
      retryCount.current = 0;
      void initialize();
    };
    /* `readyState` is the browser's opinion, not the network's. A socket that
       survived a sleep has to prove it is still there, so ask — and re-attach
       every stream from its cursor, which is what collects whatever happened
       while the phone was away. The gateway settles any live subscription
       before adding another, so re-attaching an attached stream is a catch-up
       rather than a second delivery. */
    const wake = () => {
      if (stateRef.current.authRequired || socketRetryBlocked.current) return;
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        recover();
        return;
      }
      const now = Date.now();
      if (now - lastProbeAt.current < PROBE_COALESCE_MS) return;
      lastProbeAt.current = now;
      probeRef.current?.();
      for (const streamId of subscriptions.current) attach(streamId);
    };
    const recoverWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      // An already-offline connection has nothing to probe; it needs the
      // bootstrap, which is what surfaces an expired session as a 401.
      if (stateRef.current.connection === "offline") {
        recover();
        return;
      }
      wake();
    };
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recoverWhenVisible);
    return () => {
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
    };
  }, [attach, initialize]);

  const pair = useCallback(
    async (token: string) => {
      await api.pair(token, deviceLabel());
      await initialize();
    },
    [initialize],
  );

  const openAgent = useCallback(
    async (id: string) => {
      const generation = sessionGeneration.current;
      // Captured before any await, so two calls fired back to back (a fast
      // double-tap between two cold sessions) get distinct, increasing values.
      const openGeneration = ++openAgentGeneration.current;
      const streamId = `agent:${id}`;
      subscriptions.current.add(streamId);
      attach(streamId);
      if (!stateRef.current.snapshots[id]) {
        try {
          const loaded = await loadAgentHttp(id);
          if (generation !== sessionGeneration.current) return;
          // Deliberately not gated on openGeneration: a superseded call's own
          // snapshot is still worth caching, and dispatching it here is what
          // lets the *newer* call's own cleanup below see this agent already
          // has a snapshot instead of wrongly detaching it.
          dispatchLoadedSnapshot(loaded);
        } catch (error) {
          if (generation !== sessionGeneration.current) return;
          // Recorded for the panel, then rethrown unchanged. Every existing
          // caller keeps its own handling: selectAgent still rolls the
          // selection back, createSession still reports that the session was
          // created but could not be opened. This only adds the per-agent
          // reason the panel needs to offer a retry.
          const message = transcriptErrorMessage(error);
          if (message) dispatch({ type: "transcript_error", agentId: id, message });
          throw error;
        }
      }
      if (generation !== sessionGeneration.current) return;
      // A call that has been superseded by a newer openAgent() must not run
      // this cleanup: it can only see "no snapshot yet" for the newer call's
      // agent, not "superseded", and would detach the live stream the newer
      // (currently selected) call just attached.
      if (openGeneration !== openAgentGeneration.current) return;
      for (const existing of subscriptions.current) {
        if (existing !== "catalog" && existing !== streamId && !stateRef.current.snapshots[existing.slice(6)]) {
          detach(existing);
        }
      }
    },
    [attach, detach, dispatchLoadedSnapshot, loadAgentHttp],
  );

  const selectAgent = useCallback(
    async (id: string) => {
      const previous = stateRef.current.selectedAgentId;
      const selection = ++selectionGeneration.current;
      dispatch({ type: "select", value: id });
      try {
        await openAgent(id);
        if (selection === selectionGeneration.current) showError(null);
      } catch (error) {
        if (selection !== selectionGeneration.current) return;
        // Only back to an agent that is still there. A catalog event arriving
        // while the fetch was in flight may already have dropped it and
        // repointed the selection, and rolling back would select a ghost.
        if (previous == null || stateRef.current.catalog.agents.some((agent) => agent.id === previous)) {
          dispatch({ type: "select", value: previous });
        }
        if (!(error instanceof ApiError && error.status === 401)) {
          showError(humanizeError(error, "Could not open agent"));
        }
      }
    },
    [openAgent, showError],
  );

  const runMutation = useCallback(
    async <T extends MutationAccepted,>(
      agentId: string,
      run: (revision: number) => Promise<T>,
      initialRevision?: number,
    ): Promise<T> => {
      const generation = sessionGeneration.current;
      const revision = initialRevision ?? stateRef.current.snapshots[agentId]?.revision;
      if (revision == null) throw new Error("Agent snapshot is not loaded");
      try {
        const result = await run(revision);
        if (generation !== sessionGeneration.current) throw new DOMException("Session changed", "AbortError");
        return result;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const loaded = await loadAgentHttp(agentId);
        if (generation !== sessionGeneration.current) throw new DOMException("Session changed", "AbortError");
        dispatchLoadedSnapshot(loaded);
        const result = await run(loaded.snapshot.revision);
        if (generation !== sessionGeneration.current) throw new DOMException("Session changed", "AbortError");
        return result;
      }
    },
    [dispatchLoadedSnapshot, loadAgentHttp],
  );

  const createSession = useCallback(
    async (cwd: string, name?: string, callerRequestId?: string) => {
      const current = stateRef.current;
      const generation = sessionGeneration.current;
      const retryKey = JSON.stringify([cwd, name ?? ""]);
      const requestId = callerRequestId ?? createRequestIdsRef.current.get(retryKey) ?? crypto.randomUUID();
      createRequestIdsRef.current.set(retryKey, requestId);
      let result;
      try {
        result = await api.createSession(current.csrfToken, cwd, name, requestId);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          showError(humanizeError(error, "Could not create the session"));
        }
        throw error;
      }
      if (createRequestIdsRef.current.get(retryKey) === requestId) createRequestIdsRef.current.delete(retryKey);
      if (generation !== sessionGeneration.current) throw new DOMException("Session changed", "AbortError");

      dispatch({ type: "select", value: result.agentId });
      try {
        await openAgent(result.agentId);
        showError(null);
      } catch (error) {
        // The create mutation is committed. Hydration can be retried and must not
        // make the caller report that creation itself failed.
        if (!(error instanceof ApiError && error.status === 401)) {
          showError(`Session created, but it could not be opened: ${humanizeError(error, "unknown error")}`);
        }
      }
      return result.agentId;
    },
    [openAgent, showError],
  );

  const send = useCallback(
    async (text: string, images: PreparedImage[] = [], requestId: string = crypto.randomUUID()) => {
      const current = stateRef.current;
      const id = current.selectedAgentId;
      const snapshot = id ? current.snapshots[id] : null;
      if (!id || !snapshot) throw new Error("No agent selected");
      const displayText = text || (images.length ? "Image attached." : "");
      const pendingAttachments = images.map(pendingAttachment);
      for (const attachment of pendingAttachments) {
        if (attachment.ownsPreviewUrl && attachment.previewUrl) pendingPreviewUrlsRef.current.add(attachment.previewUrl);
      }
      const knownUserMessageIds = requestBaselinesRef.current.get(requestId)
        ?? snapshot.messages.filter((message) => message.role === "user").map((message) => message.id);
      requestBaselinesRef.current.set(requestId, knownUserMessageIds);
      while (requestBaselinesRef.current.size > 100) {
        const oldest = requestBaselinesRef.current.keys().next().value as string | undefined;
        if (!oldest) break;
        requestBaselinesRef.current.delete(oldest);
      }
      const pendingMessage: PendingMessage = {
        id: requestId,
        text: displayText,
        createdAt: new Date().toISOString(),
        knownUserMessageIds,
        ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
      };
      const echoAlreadyPresent = reconcilePending([pendingMessage], snapshot.messages).length === 0;
      if (echoAlreadyPresent) {
        for (const attachment of pendingAttachments) {
          if (!attachment.ownsPreviewUrl || !attachment.previewUrl) continue;
          pendingPreviewUrlsRef.current.delete(attachment.previewUrl);
          URL.revokeObjectURL(attachment.previewUrl);
        }
      } else {
        dispatch({ type: "pending_add", agentId: id, value: pendingMessage });
      }
      try {
        const requestImages = imageInputsForRequest(images);
        const result = await runMutation(id, (revision) => api.sendMessage(id, current.csrfToken, revision, text, requestImages, requestId));
        requestBaselinesRef.current.delete(requestId);
        dispatch({ type: "agent_revision", agentId: id, revision: result.revision });
        showError(null);
      } catch (error) {
        if (!echoAlreadyPresent) dispatch({ type: "pending_remove", agentId: id, id: pendingMessage.id });
        showError(humanizeError(error, "Message failed"));
        throw error;
      }
    },
    [runMutation, showError],
  );

  const loadSlashCommands = useCallback((agentId: string) => api.loadSlashCommandCatalog(agentId), []);

  const runSlashCommand = useCallback(
    async (name: string, args: string, requestId: string = crypto.randomUUID()): Promise<SlashCommandResult> => {
      const current = stateRef.current;
      const id = current.selectedAgentId;
      if (!id || !current.snapshots[id]) throw new Error("No agent selected");
      try {
        const result = await runMutation(
          id,
          (revision) => api.executeSlashCommand(id, current.csrfToken, revision, name, args, requestId),
        );
        dispatch({ type: "agent_revision", agentId: id, revision: result.revision });
        showError(null);
        return result.result;
      } catch (error) {
        showError(humanizeError(error, "Command failed"));
        throw error;
      }
    },
    [runMutation, showError],
  );

  // Every mutation reachable from the drawer can name a session the user has
  // never opened, and so has no snapshot — and therefore no revision to echo —
  // in the store yet. Fetching one is the first step of all of them.
  const loadedRevision = useCallback(async (agentId: string, generation: number): Promise<number> => {
    const existing = stateRef.current.snapshots[agentId];
    if (existing) return existing.revision;
    const loaded = await loadAgentHttp(agentId);
    if (generation !== sessionGeneration.current) throw new DOMException("Session changed", "AbortError");
    dispatchLoadedSnapshot(loaded);
    return loaded.snapshot.revision;
  }, [dispatchLoadedSnapshot, loadAgentHttp]);

  /**
   * The shared body of an agent mutation: resolve the revision to apply it
   * against, run it, record the new revision or show the failure, all guarded
   * on the session generation so nothing lands in a store that has moved on.
   * `onSuccess` replaces the revision record; only deletion needs that, since
   * there is no agent left to carry one.
   */
  const guardedMutation = useCallback(async <T extends MutationAccepted,>(
    agentId: string,
    call: (csrfToken: string, revision: number) => Promise<T>,
    errorMessage: string,
    onSuccess?: (result: T) => void | Promise<void>,
  ): Promise<void> => {
    const { csrfToken } = stateRef.current;
    const generation = sessionGeneration.current;
    try {
      const revision = await loadedRevision(agentId, generation);
      const result = await runMutation(agentId, (next) => call(csrfToken, next), revision);
      if (generation !== sessionGeneration.current) return;
      if (onSuccess) await onSuccess(result);
      else dispatch({ type: "agent_revision", agentId, revision: result.revision });
      showError(null);
    } catch (error) {
      if (generation === sessionGeneration.current) {
        showError(humanizeError(error, errorMessage));
      }
      throw error;
    }
  }, [loadedRevision, runMutation, showError]);

  const abort = useCallback(async (agentId?: string) => {
    const id = agentId ?? stateRef.current.selectedAgentId;
    if (!id) throw new Error("No agent selected");
    await guardedMutation(id, (csrfToken, revision) => api.abortAgent(id, csrfToken, revision), "Stop failed");
  }, [guardedMutation]);

  const stop = useCallback(async (agentId: string) => {
    await guardedMutation(
      agentId,
      (csrfToken, revision) => api.stopAgent(agentId, csrfToken, revision),
      "Could not end the session",
    );
  }, [guardedMutation]);

  // Irreversible, so it is the one mutation that names what it believes it is
  // deleting: the gateway refuses if `confirmName` is not the session's
  // current name.
  const deleteSession = useCallback(async (agentId: string, confirmName: string) => {
    await guardedMutation(
      agentId,
      (csrfToken, revision) => api.deleteAgent(agentId, csrfToken, revision, confirmName),
      "Could not delete the session",
      // Deliberately no `agent_revision` dispatch: there is no agent left to
      // carry one. The catalog event removes the row, and the reducer moves
      // the selection off it — this only has to reopen whatever it landed on,
      // because a selection alone does not load a transcript.
      async () => {
        dispatch({ type: "evict_snapshot", agentId });
        const next = stateRef.current.selectedAgentId;
        if (next && next !== agentId && !stateRef.current.snapshots[next]) {
          await openAgent(next).catch(() => {});
        }
      },
    );
  }, [guardedMutation, openAgent]);

  const rename = useCallback(async (agentId: string, name: string) => {
    await guardedMutation(
      agentId,
      (csrfToken, revision) => api.renameAgent(agentId, csrfToken, revision, name),
      "Rename failed",
    );
  }, [guardedMutation]);

  const respond = useCallback(
    async (attentionId: string, revision: number, optionId: string) => {
      const current = stateRef.current;
      const generation = sessionGeneration.current;
      const agentId = Object.values(current.snapshots)
        .flatMap((snapshot) => snapshot.attention)
        .find((request) => request.id === attentionId)?.agentId ?? current.selectedAgentId;
      try {
        const result = await api.respondToAttention(attentionId, current.csrfToken, revision, optionId);
        if (generation !== sessionGeneration.current) return;
        if (agentId) dispatch({ type: "agent_revision", agentId, revision: result.revision });
        showError(null);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          showError(humanizeError(error, "Response failed"));
        }
        throw error;
      }
    },
    [showError],
  );

  const signOut = useCallback(async () => {
    // Before the request, not after: the gateway drops its records when the
    // session dies, and the browser must stop holding a wake capability even
    // if the network call fails. An expiry deliberately does neither.
    await revokePushLocally().catch(() => {});
    try {
      await api.signOut(stateRef.current.csrfToken);
    } catch (error) {
      // Anything but a 401 means the server may still honour the cookie, so
      // clearing local state here would only fake a sign-out.
      if (!(error instanceof ApiError && error.status === 401)) {
        showError(humanizeError(error, "Sign out failed"));
        return;
      }
    }
    resetForUnauthorized(true);
  }, [resetForUnauthorized, showError]);

  const reconnect = useCallback(() => {
    retryCount.current = 0;
    socketRetryBlocked.current = false;
    if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    socketGeneration.current += 1;
    replayingStreams.current.clear();
    socket?.close();
    void initialize();
  }, [initialize]);

  const selectedAgent = state.catalog.agents.find((item) => item.id === state.selectedAgentId) ?? null;
  const selectedSnapshot = state.selectedAgentId ? state.snapshots[state.selectedAgentId] ?? null : null;
  const pendingMessages = state.selectedAgentId ? state.pending[state.selectedAgentId] ?? [] : [];
  // One count for the header badge, the drawer summary strip and the app icon.
  // Signing out resets the catalog, which clears the icon badge for free.
  const attentionCount = attentionAgentCount(state.catalog.agents);
  useAppBadge(attentionCount);
  /* The way out of a failed transcript. Clearing the error first puts the
     spinner back, so a retry that is itself slow still looks like progress
     rather than a dead button. The attach is retried too: the socket may have
     been the thing that failed. */
  const retryTranscript = useCallback(async (agentId: string) => {
    const generation = sessionGeneration.current;
    const streamId = `agent:${agentId}`;
    dispatch({ type: "transcript_error", agentId, message: null });
    subscriptions.current.add(streamId);
    attach(streamId);
    try {
      const loaded = await loadAgentHttp(agentId);
      if (generation !== sessionGeneration.current) return;
      dispatchLoadedSnapshot(loaded);
    } catch (error) {
      if (generation !== sessionGeneration.current) return;
      const message = transcriptErrorMessage(error);
      if (message) dispatch({ type: "transcript_error", agentId, message });
    }
  }, [attach, dispatchLoadedSnapshot, loadAgentHttp]);

  const value = useMemo<GatewayContextValue>(
    () => ({
      ...state,
      selectedAgent,
      selectedSnapshot,
      pendingMessages,
      attentionCount,
      pair,
      selectAgent,
      createSession,
      send,
      loadSlashCommands,
      runSlashCommand,
      abort,
      rename,
      stop,
      deleteSession,
      respond,
      signOut,
      reconnect,
      retryTranscript,
    }),
    [state, selectedAgent, selectedSnapshot, pendingMessages, attentionCount, pair, selectAgent, createSession, send, loadSlashCommands, runSlashCommand, abort, rename, stop, deleteSession, respond, signOut, reconnect, retryTranscript],
  );
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayContextValue {
  const value = useContext(GatewayContext);
  if (!value) throw new Error("useGateway must be used inside GatewayProvider");
  return value;
}
