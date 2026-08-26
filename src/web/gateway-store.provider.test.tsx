import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, AgentSummary, BootstrapResponse, ServerFrame } from "../protocol";

const apiMock = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return {
    ApiError: MockApiError,
    bootstrap: vi.fn(),
    loadAgent: vi.fn(),
    pair: vi.fn(),
    onUnauthorized: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    loadSlashCommandCatalog: vi.fn(),
    executeSlashCommand: vi.fn(),
    abortAgent: vi.fn(),
    respondToAttention: vi.fn(),
    signOut: vi.fn(),
    unauthorized: null as null | (() => void),
  };
});

vi.mock("./api", () => ({
  ApiError: apiMock.ApiError,
  bootstrap: apiMock.bootstrap,
  loadAgent: apiMock.loadAgent,
  pair: apiMock.pair,
  onUnauthorized: apiMock.onUnauthorized,
  createSession: apiMock.createSession,
  sendMessage: apiMock.sendMessage,
  loadSlashCommandCatalog: apiMock.loadSlashCommandCatalog,
  executeSlashCommand: apiMock.executeSlashCommand,
  abortAgent: apiMock.abortAgent,
  respondToAttention: apiMock.respondToAttention,
  signOut: apiMock.signOut,
  humanizeError: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

import {
  GatewayProvider,
  SOCKET_OPEN_TIMEOUT_MS,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PONG_TIMEOUT_MS,
  useGateway,
} from "./gateway-store";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string) {
    this.sent.push(value);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  message(frame: ServerFrame | unknown) {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", new CloseEvent("close", { code, reason }));
  }

  private emit(type: string, event: Event | MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function summary(id: string): AgentSummary {
  return {
    id,
    rootId: id,
    parentId: null,
    depth: 0,
    name: id,
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: {
      send: true,
      abort: true,
      resume: false,
      rename: false,
      stop: false,
      deactivate: false,
      delete: false,
      respond: true,
      images: true,
    },
  };
}

function snapshot(agentId: string, revision = 1): AgentSnapshot {
  return { agentId, revision, messages: [], attention: [] };
}

function bootstrap(agents: AgentSummary[] = []): BootstrapResponse {
  return {
    protocolVersion: 1,
    csrfToken: "csrf",
    backend: "demo",
    push: { enabled: false, publicKey: null },
    catalog: { revision: 1, agents },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
  MockWebSocket.instances = [];
  apiMock.unauthorized = null;
  apiMock.onUnauthorized.mockImplementation((handler: () => void) => {
    apiMock.unauthorized = handler;
    return () => {
      if (apiMock.unauthorized === handler) apiMock.unauthorized = null;
    };
  });
  apiMock.bootstrap.mockReset().mockResolvedValue(bootstrap());
  apiMock.loadAgent.mockReset();
  apiMock.pair.mockReset().mockResolvedValue({ csrfToken: "csrf" });
  apiMock.createSession.mockReset();
  apiMock.sendMessage.mockReset();
  apiMock.loadSlashCommandCatalog.mockReset();
  apiMock.executeSlashCommand.mockReset();
  apiMock.abortAgent.mockReset();
  apiMock.respondToAttention.mockReset();
  apiMock.signOut.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("GatewayProvider notification routing", () => {
  // A notification tap opens `/?agent=<id>`; without this the app would land
  // on the first root session and the user would have to find the one that
  // buzzed them.
  it("selects the agent a notification tap named, ahead of the first root", async () => {
    window.history.replaceState(null, "", "/?agent=agent-b");
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-b"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-b"));
    expect(apiMock.loadAgent).toHaveBeenCalledWith("agent-b", expect.anything());
    // Stripped, so a reload does not keep dragging the user back.
    expect(window.location.search).toBe("");
  });

  it("ignores an agent the catalog does not have", async () => {
    window.history.replaceState(null, "", "/?agent=agent-deleted");
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-a"));
  });
});

describe("GatewayProvider recovery and state ownership", () => {
  it("starts the socket independently and exposes a retryable bootstrap failure", async () => {
    apiMock.bootstrap
      .mockRejectedValueOnce(new Error("bootstrap unavailable"))
      .mockResolvedValueOnce(bootstrap());
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.connection).toBe("offline"));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(result.current.error).toContain("bootstrap unavailable");

    act(() => result.current.reconnect());
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalledTimes(2));
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("makes a root snapshot failure visible and retryable", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new Error("root snapshot unavailable"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.connection).toBe("offline"));
    expect(result.current.error).toContain("root snapshot unavailable");
    expect(result.current.catalog.agents[0].id).toBe("agent-a");
  });

  it("ignores an older bootstrap lifecycle after reconnect", async () => {
    const first = deferred<BootstrapResponse>();
    apiMock.bootstrap
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...bootstrap(), catalog: { revision: 2, agents: [] } });
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalledTimes(1));

    act(() => result.current.reconnect());
    await waitFor(() => expect(result.current.catalog.revision).toBe(2));
    first.resolve({ ...bootstrap(), catalog: { revision: 1, agents: [summary("stale")] } });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.catalog.revision).toBe(2);
    expect(result.current.catalog.agents).toEqual([]);
  });

  it("ignores close and message callbacks from an obsolete socket generation", async () => {
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());
    const oldSocket = MockWebSocket.instances[0];
    act(() => result.current.reconnect());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const currentSocket = MockWebSocket.instances[1];
    act(() => currentSocket.open());
    expect(result.current.connection).toBe("live");

    act(() => oldSocket.message({ type: "pong", version: 1 }));
    act(() => oldSocket.close());

    expect(result.current.connection).toBe("live");
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("turns an expired-session websocket close into centralized auth reset", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    act(() => socket.close(1008, "Session expired"));

    expect(result.current.authRequired).toBe(true);
    expect(result.current.snapshots).toEqual({});
    expect(result.current.catalog.agents).toEqual([]);
  });

  it("blocks blind retries after an oversized server frame but allows manual retry", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    act(() => socket.close(1009, "Server frame is too large"));
    expect(result.current.connection).toBe("offline");
    expect(result.current.error).toContain("too large");
    act(() => { vi.advanceTimersByTime(120_000); });
    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => { await Promise.resolve(); });
    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => result.current.reconnect());
    await act(async () => { await Promise.resolve(); });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("times out a socket handshake and recovers with backoff", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];

    act(() => { vi.advanceTimersByTime(SOCKET_OPEN_TIMEOUT_MS); });
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(result.current.connection).toBe("offline");
    expect(result.current.error).toContain("timed out");

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("re-initializes after 2 consecutive socket failures and routes a 401 to pairing", async () => {
    apiMock.bootstrap
      .mockResolvedValueOnce(bootstrap([summary("agent-a")]))
      .mockRejectedValueOnce(new apiMock.ApiError(401, "Session expired"));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    vi.useFakeTimers();

    // First consecutive failure: still just a plain socket retry.
    act(() => MockWebSocket.instances[0].close(1006, "abnormal closure"));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(apiMock.bootstrap).toHaveBeenCalledTimes(1);

    // Second consecutive failure: re-runs the HTTP bootstrap instead of only
    // retrying the socket, which is what can observe a 401 at all.
    act(() => MockWebSocket.instances[1].close(1006, "abnormal closure"));
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.authRequired).toBe(true);
  });

  it("keeps retrying without a false auth-required when the escalated bootstrap succeeds but the socket still fails", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    vi.useFakeTimers();

    act(() => MockWebSocket.instances[0].close(1006, "abnormal closure"));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => MockWebSocket.instances[1].close(1006, "abnormal closure"));
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(3);
    expect(result.current.authRequired).toBe(false);

    // The socket keeps failing even though bootstrap is healthy; the retry
    // ladder must keep producing new attempts rather than stalling.
    const latest = MockWebSocket.instances.at(-1)!;
    act(() => latest.close(1006, "abnormal closure"));
    act(() => { vi.advanceTimersByTime(4_000); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(4);
    expect(result.current.authRequired).toBe(false);
  });

  it("clears all private state when the central 401 handler runs", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    act(() => apiMock.unauthorized?.());

    expect(result.current.authRequired).toBe(true);
    expect(result.current.csrfToken).toBe("");
    expect(result.current.backend).toBeNull();
    expect(result.current.catalog.agents).toEqual([]);
    expect(result.current.snapshots).toEqual({});
    expect(result.current.selectedAgentId).toBeNull();
  });

  it("signs out to the login screen without an expired-session greeting", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(async () => { await result.current.signOut(); });

    expect(apiMock.signOut).toHaveBeenCalledWith("csrf");
    expect(result.current.authRequired).toBe(true);
    expect(result.current.hadSession).toBe(false);
    expect(result.current.snapshots).toEqual({});
    expect(result.current.csrfToken).toBe("");
  });

  it("keeps the session when sign-out fails, rather than faking it locally", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    apiMock.signOut.mockRejectedValue(new Error("gateway unreachable"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(async () => { await result.current.signOut(); });

    expect(result.current.authRequired).toBe(false);
    expect(result.current.error).toContain("gateway unreachable");
    expect(result.current.selectedSnapshot?.agentId).toBe("agent-a");
  });

  it("treats a sign-out on an already-dead session as done", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    apiMock.signOut.mockRejectedValue(new apiMock.ApiError(401, "Authentication required"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(async () => { await result.current.signOut(); });

    expect(result.current.authRequired).toBe(true);
    expect(result.current.hadSession).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("rolls selection back when its snapshot cannot load", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => id === "agent-a"
      ? Promise.resolve(snapshot(id))
      : Promise.reject(new Error("snapshot failed")));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(() => result.current.selectAgent("agent-b"));

    expect(result.current.selectedAgentId).toBe("agent-a");
    expect(result.current.error).toContain("snapshot failed");
  });

  it("does not let a late equal-revision HTTP snapshot replace newer websocket state", async () => {
    const http = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockReturnValue(http.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    const selecting = act(() => result.current.selectAgent("agent-a"));
    const realtime = snapshot("agent-a", 5);
    realtime.messages = [{
      id: "message",
      role: "assistant",
      text: "new realtime text",
      state: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    act(() => socket.message({
      type: "snapshot",
      version: 1,
      streamId: "agent:agent-a",
      cursor: { epoch: "epoch", seq: 5 },
      snapshot: realtime,
    }));
    const staleHttp = snapshot("agent-a", 5);
    staleHttp.messages = [{ ...realtime.messages[0], text: "stale HTTP text" }];
    http.resolve(staleHttp);
    await selecting;

    await waitFor(() => expect(result.current.snapshots["agent-a"]?.messages[0]?.text).toBe("new realtime text"));
  });

  it("accepts an HTTP snapshot for a newly opened agent even if unrelated realtime traffic touched the stream first", async () => {
    const http = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockReturnValue(http.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    const selecting = act(() => result.current.selectAgent("agent-a"));
    // A realtime event for this stream arrives before any snapshot exists locally
    // (e.g. the server races an event ahead of the initial full sync). The event
    // itself is dropped because there is nothing to apply it to, but it still bumps
    // the stream's realtime version, making the in-flight HTTP fetch's
    // allowEqualRevision false.
    act(() => socket.message({
      type: "event",
      version: 1,
      envelope: {
        version: 1,
        streamId: "agent:agent-a",
        epoch: "epoch",
        seq: 1,
        emittedAt: "2026-01-01T00:00:00.000Z",
        event: {
          kind: "agent.activity_added",
          payload: { id: "activity-1", kind: "tool", title: "Tool", status: "running", createdAt: "2026-01-01T00:00:00.000Z" },
        },
      },
    }));
    http.resolve(snapshot("agent-a"));
    await selecting;

    // The stream was never marked gone, so the HTTP snapshot must still populate
    // the agent instead of leaving it stuck with no snapshot at all.
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
    expect(result.current.snapshots["agent-a"]?.revision).toBe(1);
  });

  it("does not restore a late HTTP snapshot after its stream is gone", async () => {
    const http = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockReturnValue(http.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    const selecting = act(() => result.current.selectAgent("gone"));
    // The HTTP baseline is captured at zero: no WS snapshot/event has arrived.
    expect(apiMock.loadAgent).toHaveBeenCalledWith("gone", undefined);
    act(() => socket.message({
      type: "detached",
      version: 1,
      streamId: "agent:gone",
      reason: "stream_gone",
    }));
    http.resolve(snapshot("gone"));
    await selecting;

    expect(result.current.snapshots.gone).toBeUndefined();
  });

  it("reuses a create request id after failure and treats hydration as separate", async () => {
    apiMock.createSession
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce({ requestId: "ignored", agentId: "created" });
    apiMock.loadAgent.mockRejectedValue(new Error("hydrate failed"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());

    await expect(result.current.createSession("/work", "Name")).rejects.toThrow("network failed");
    let created: string | undefined;
    await act(async () => { created = await result.current.createSession("/work", "Name"); });
    expect(created).toBe("created");

    expect(apiMock.createSession.mock.calls[0][3]).toBe(apiMock.createSession.mock.calls[1][3]);
    expect(result.current.error).toContain("Session created, but it could not be opened");
  });

  it("does not invalidate a committed send when initialization restarts", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const sending = deferred<{ accepted: true; requestId: string; revision: number }>();
    apiMock.sendMessage.mockReturnValue(sending.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    const committed = result.current.send("hello", [], "11111111-1111-4111-8111-111111111111");
    act(() => result.current.reconnect());
    sending.resolve({ accepted: true, requestId: "request", revision: 2 });

    await expect(committed).resolves.toBeUndefined();
    await waitFor(() => expect(result.current.snapshots["agent-a"].revision).toBe(2));
  });

  it("does not invalidate a committed create when initialization restarts", async () => {
    const creating = deferred<{ requestId: string; agentId: string }>();
    apiMock.createSession.mockReturnValue(creating.promise);
    apiMock.loadAgent.mockResolvedValue(snapshot("created"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());

    const committed = result.current.createSession("/work", "Name");
    act(() => result.current.reconnect());
    creating.resolve({ requestId: "request", agentId: "created" });

    await expect(committed).resolves.toBe("created");
  });

  it("does not repopulate private state when auth resets during abort preload", async () => {
    const loading = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockReturnValue(loading.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());

    const stopping = result.current.abort("agent-a").catch((error: unknown) => error);
    act(() => apiMock.unauthorized?.());
    loading.resolve(snapshot("agent-a"));
    const error = await stopping;

    expect(error).toMatchObject({ name: "AbortError" });
    expect(result.current.authRequired).toBe(true);
    expect(result.current.snapshots).toEqual({});
    expect(apiMock.abortAgent).not.toHaveBeenCalled();
  });

  it("stops an abort preload after provider unmount", async () => {
    const loading = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockReturnValue(loading.promise);
    const { result, unmount } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());

    const stopping = result.current.abort("agent-a").catch((error: unknown) => error);
    unmount();
    loading.resolve(snapshot("agent-a"));

    await expect(stopping).resolves.toMatchObject({ name: "AbortError" });
    expect(apiMock.abortAgent).not.toHaveBeenCalled();
  });

  it("applies an attention response to its owning agent after selection changes", async () => {
    const attentionSnapshot = snapshot("agent-a");
    attentionSnapshot.attention = [{
      id: "attention",
      agentId: "agent-a",
      kind: "question",
      title: "Question",
      revision: 1,
      options: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(id === "agent-a" ? attentionSnapshot : snapshot(id)));
    const response = deferred<{ accepted: true; requestId: string; revision: number }>();
    apiMock.respondToAttention.mockReturnValue(response.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    let responding!: Promise<void>;
    act(() => { responding = result.current.respond("attention", 1, "yes"); });
    await act(() => result.current.selectAgent("agent-b"));
    response.resolve({ accepted: true, requestId: "request", revision: 9 });
    await act(() => responding);

    expect(result.current.snapshots["agent-a"].revision).toBe(9);
    expect(result.current.snapshots["agent-b"].revision).toBe(1);
  });

  it("closes a socket that misses its pong deadline", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    act(() => { vi.advanceTimersByTime(SOCKET_PING_INTERVAL_MS); });
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "ping", version: 1 });
    act(() => { vi.advanceTimersByTime(SOCKET_PONG_TIMEOUT_MS); });

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(result.current.connection).toBe("offline");
  });

  it("keeps subscriptions across server shutdown and reattaches after reconnect", async () => {
    vi.useFakeTimers();
    renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: "attach",
      streamId: "catalog",
    }));

    act(() => socket.message({
      type: "detached",
      version: 1,
      streamId: "catalog",
      reason: "server_shutdown",
    }));
    act(() => { vi.advanceTimersByTime(1_000); });
    const replacement = MockWebSocket.instances[1];
    expect(replacement).toBeDefined();
    act(() => replacement.open());

    expect(replacement.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: "attach",
      streamId: "catalog",
    }));
  });

  it.each(["invalid_cursor", "lagged"] as const)("drops a %s cursor before reattaching", async (reason) => {
    renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.message({
      type: "snapshot",
      version: 1,
      streamId: "catalog",
      cursor: { epoch: "old-epoch", seq: 7 },
      snapshot: { revision: 0, agents: [] },
    }));
    socket.sent.length = 0;

    act(() => socket.message({
      type: "detached",
      version: 1,
      streamId: "catalog",
      reason,
    }));

    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "attach",
      version: 1,
      streamId: "catalog",
      since: null,
    });
  });

  it("keeps the global phase replaying while any stream still has a gap", async () => {
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalled());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.message({
      type: "snapshot",
      version: 1,
      streamId: "catalog",
      cursor: { epoch: "epoch", seq: 0 },
      snapshot: { revision: 0, agents: [] },
    }));
    act(() => socket.message({
      type: "event",
      version: 1,
      envelope: {
        version: 1,
        streamId: "catalog",
        epoch: "epoch",
        seq: 2,
        emittedAt: "2026-01-01T00:00:00.000Z",
        event: { kind: "catalog.replaced", payload: { revision: 2, agents: [] } },
      },
    }));
    expect(result.current.connection).toBe("replaying");

    act(() => socket.message({
      type: "replay",
      version: 1,
      streamId: "agent:agent-a",
      cursor: { epoch: "epoch", seq: 0 },
      events: [],
    }));

    expect(result.current.connection).toBe("replaying");
  });
});
