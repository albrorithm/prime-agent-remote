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
  ServerFrame,
  StreamCursor,
} from "../protocol";
import { PROTOCOL_VERSION } from "../protocol";
import * as api from "./api";
import { ApiError } from "./api";

export type MobileView = "agents" | "current" | "activity";
export type ConnectionPhase = "checking" | "connecting" | "live" | "offline" | "replaying";

interface State {
  authRequired: boolean;
  connection: ConnectionPhase;
  csrfToken: string;
  backend: "demo" | "prime" | null;
  catalog: CatalogSnapshot;
  snapshots: Record<string, AgentSnapshot>;
  selectedAgentId: string | null;
  mobileView: MobileView;
  error: string | null;
}

type Action =
  | { type: "bootstrap"; value: BootstrapResponse }
  | { type: "auth_required" }
  | { type: "connection"; value: ConnectionPhase }
  | { type: "catalog"; value: CatalogSnapshot }
  | { type: "snapshot"; value: AgentSnapshot }
  | { type: "event"; value: EventEnvelope }
  | { type: "agent_revision"; agentId: string; revision: number }
  | { type: "select"; value: string }
  | { type: "view"; value: MobileView }
  | { type: "error"; value: string | null };

const emptyCatalog: CatalogSnapshot = { revision: 0, agents: [] };
const initialState: State = {
  authRequired: false,
  connection: "checking",
  csrfToken: "",
  backend: null,
  catalog: emptyCatalog,
  snapshots: {},
  selectedAgentId: null,
  mobileView: "agents",
  error: null,
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
      return event.payload;
    case "agent.message_added":
    case "agent.message_updated":
      return { ...snapshot, messages: upsertById(snapshot.messages, event.payload) };
    case "agent.activity_added":
    case "agent.activity_updated":
      return { ...snapshot, activity: upsertById(snapshot.activity, event.payload) };
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
      const first = action.value.catalog.agents.find((agent) => agent.parentId === null)?.id ?? null;
      return {
        ...state,
        authRequired: false,
        connection: "connecting",
        csrfToken: action.value.csrfToken,
        backend: action.value.backend,
        catalog: action.value.catalog,
        selectedAgentId: state.selectedAgentId ?? first,
        error: null,
      };
    }
    case "auth_required":
      return { ...state, authRequired: true, connection: "offline", csrfToken: "" };
    case "connection":
      return { ...state, connection: action.value };
    case "catalog":
      return { ...state, catalog: action.value };
    case "snapshot":
      return { ...state, snapshots: { ...state.snapshots, [action.value.agentId]: action.value } };
    case "event": {
      if (action.value.event.kind === "catalog.replaced") {
        return { ...state, catalog: action.value.event.payload };
      }
      const agentId = action.value.streamId.startsWith("agent:") ? action.value.streamId.slice(6) : null;
      if (!agentId) return state;
      const current = state.snapshots[agentId];
      if (!current) return state;
      const updated = applyGatewayEvent(current, action.value.event);
      return {
        ...state,
        snapshots: { ...state.snapshots, [agentId]: updated },
      };
    }
    case "agent_revision": {
      const current = state.snapshots[action.agentId];
      if (!current) return state;
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.agentId]: { ...current, revision: action.revision },
        },
      };
    }
    case "select":
      return { ...state, selectedAgentId: action.value };
    case "view":
      return { ...state, mobileView: action.value };
    case "error":
      return { ...state, error: action.value };
  }
}

interface GatewayContextValue extends State {
  selectedAgent: AgentSummary | null;
  selectedSnapshot: AgentSnapshot | null;
  pair: (token: string) => Promise<void>;
  selectAgent: (id: string, openCurrent?: boolean) => Promise<void>;
  setMobileView: (view: MobileView) => void;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  respond: (attentionId: string, revision: number, optionId: string) => Promise<void>;
  reconnect: () => void;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

function socketUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1/events`;
}

export function GatewayProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const retryCount = useRef(0);
  const cursors = useRef(new Map<string, StreamCursor>());
  const subscriptions = useRef(new Set<string>(["catalog"]));
  const manuallyClosed = useRef(false);
  stateRef.current = state;

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

  const connect = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
    if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
    dispatch({ type: "connection", value: "connecting" });
    const socket = new WebSocket(socketUrl());
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      retryCount.current = 0;
      dispatch({ type: "connection", value: "live" });
      for (const streamId of subscriptions.current) attach(streamId);
    });
    socket.addEventListener("message", (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(message.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.version !== PROTOCOL_VERSION || frame.type === "pong") return;
      if (frame.type === "detached") {
        if (frame.reason !== "stream_gone") attach(frame.streamId);
        return;
      }
      if (frame.type === "snapshot") {
        cursors.current.set(frame.streamId, frame.cursor);
        if (frame.streamId === "catalog") dispatch({ type: "catalog", value: frame.snapshot as CatalogSnapshot });
        else dispatch({ type: "snapshot", value: frame.snapshot as AgentSnapshot });
        dispatch({ type: "connection", value: "live" });
        return;
      }
      const events = frame.type === "replay" ? frame.events : [frame.envelope];
      if (frame.type === "replay") dispatch({ type: "connection", value: "replaying" });
      for (const envelope of events) {
        const cursor = cursors.current.get(envelope.streamId);
        if (cursor?.epoch === envelope.epoch && envelope.seq <= cursor.seq) continue;
        if (cursor?.epoch === envelope.epoch && envelope.seq !== cursor.seq + 1) {
          dispatch({ type: "connection", value: "replaying" });
          attach(envelope.streamId);
          return;
        }
        cursors.current.set(envelope.streamId, { epoch: envelope.epoch, seq: envelope.seq });
        dispatch({ type: "event", value: envelope });
      }
      if (frame.type === "replay") {
        cursors.current.set(frame.streamId, frame.cursor);
        dispatch({ type: "connection", value: "live" });
      }
    });
    socket.addEventListener("close", () => {
      socketRef.current = null;
      if (manuallyClosed.current || stateRef.current.authRequired) return;
      dispatch({ type: "connection", value: "offline" });
      const delay = Math.min(30_000, 1_000 * 2 ** retryCount.current++);
      reconnectTimer.current = window.setTimeout(connect, delay);
    });
  }, [attach]);

  const initialize = useCallback(async () => {
    try {
      const value = await api.bootstrap();
      dispatch({ type: "bootstrap", value });
      const first = value.catalog.agents.find((agent) => agent.parentId === null);
      if (first) {
        const snapshot = await api.loadAgent(first.id);
        dispatch({ type: "snapshot", value: snapshot });
        subscriptions.current.add(`agent:${first.id}`);
      }
      connect();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) dispatch({ type: "auth_required" });
      else dispatch({ type: "error", value: error instanceof Error ? error.message : "Could not start the app" });
    }
  }, [connect]);

  useEffect(() => {
    manuallyClosed.current = false;
    void initialize();
    return () => {
      manuallyClosed.current = true;
      if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
      socketRef.current?.close();
    };
  }, [initialize]);

  const pair = useCallback(
    async (token: string) => {
      await api.pair(token);
      await initialize();
    },
    [initialize],
  );

  const selectAgent = useCallback(
    async (id: string, openCurrent = true) => {
      dispatch({ type: "select", value: id });
      if (openCurrent) dispatch({ type: "view", value: "current" });
      try {
        if (!stateRef.current.snapshots[id]) {
          const snapshot = await api.loadAgent(id);
          dispatch({ type: "snapshot", value: snapshot });
        }
        const streamId = `agent:${id}`;
        subscriptions.current.add(streamId);
        attach(streamId);
      } catch (error) {
        dispatch({ type: "error", value: error instanceof Error ? error.message : "Could not open agent" });
      }
    },
    [attach],
  );

  const send = useCallback(async (text: string) => {
    const current = stateRef.current;
    const id = current.selectedAgentId;
    const snapshot = id ? current.snapshots[id] : null;
    if (!id || !snapshot) throw new Error("No agent selected");
    try {
      const result = await api.sendMessage(id, current.csrfToken, snapshot.revision, text);
      dispatch({ type: "agent_revision", agentId: id, revision: result.revision });
      dispatch({ type: "error", value: null });
    } catch (error) {
      dispatch({ type: "error", value: error instanceof Error ? error.message : "Message failed" });
      throw error;
    }
  }, []);

  const abort = useCallback(async () => {
    const current = stateRef.current;
    const id = current.selectedAgentId;
    const snapshot = id ? current.snapshots[id] : null;
    if (!id || !snapshot) return;
    try {
      const result = await api.abortAgent(id, current.csrfToken, snapshot.revision);
      dispatch({ type: "agent_revision", agentId: id, revision: result.revision });
      dispatch({ type: "error", value: null });
    } catch (error) {
      dispatch({ type: "error", value: error instanceof Error ? error.message : "Stop failed" });
      throw error;
    }
  }, []);

  const respond = useCallback(async (attentionId: string, revision: number, optionId: string) => {
    const current = stateRef.current;
    try {
      const result = await api.respondToAttention(attentionId, current.csrfToken, revision, optionId);
      const agentId = current.selectedAgentId;
      if (agentId) dispatch({ type: "agent_revision", agentId, revision: result.revision });
      dispatch({ type: "error", value: null });
    } catch (error) {
      dispatch({ type: "error", value: error instanceof Error ? error.message : "Response failed" });
      throw error;
    }
  }, []);

  const setMobileView = useCallback((value: MobileView) => dispatch({ type: "view", value }), []);
  const reconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    retryCount.current = 0;
    connect();
  }, [connect]);

  const selectedAgent = state.catalog.agents.find((item) => item.id === state.selectedAgentId) ?? null;
  const selectedSnapshot = state.selectedAgentId ? state.snapshots[state.selectedAgentId] ?? null : null;
  const value = useMemo<GatewayContextValue>(
    () => ({
      ...state,
      selectedAgent,
      selectedSnapshot,
      pair,
      selectAgent,
      setMobileView,
      send,
      abort,
      respond,
      reconnect,
    }),
    [state, selectedAgent, selectedSnapshot, pair, selectAgent, setMobileView, send, abort, respond, reconnect],
  );
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayContextValue {
  const value = useContext(GatewayContext);
  if (!value) throw new Error("useGateway must be used inside GatewayProvider");
  return value;
}
