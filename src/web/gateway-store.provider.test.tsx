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
    resume: vi.fn(),
    onUnauthorized: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    loadSlashCommandCatalog: vi.fn(),
    executeSlashCommand: vi.fn(),
    abortAgent: vi.fn(),
    renameAgent: vi.fn(),
    stopAgent: vi.fn(),
    deleteAgent: vi.fn(),
    respondToAttention: vi.fn(),
    signOut: vi.fn(),
    unauthorized: null as null | (() => void),
  };
});

/**
 * A 401 exactly as the real api.ts produces one.
 *
 * `decode()` runs every central onUnauthorized handler SYNCHRONOUSLY and only
 * then throws, unless the caller passed `ownsUnauthorized`. Mocks that merely
 * rejected with an ApiError were kinder than the real thing, and that is what
 * hid a bug where the handler tore the session down before the caller's own
 * catch could spend the device credential.
 */
function unauthorized(message = "Session expired") {
  return async (options?: { ownsUnauthorized?: boolean }) => {
    if (!options?.ownsUnauthorized) apiMock.unauthorized?.();
    throw new apiMock.ApiError(401, message);
  };
}

const pushMock = vi.hoisted(() => ({
  revokePushLocally: vi.fn(async () => {}),
  reclaimPushSubscription: vi.fn(async () => {}),
}));
vi.mock("./push", () => pushMock);

vi.mock("./api", () => ({
  ApiError: apiMock.ApiError,
  bootstrap: apiMock.bootstrap,
  loadAgent: apiMock.loadAgent,
  pair: apiMock.pair,
  resume: apiMock.resume,
  onUnauthorized: apiMock.onUnauthorized,
  createSession: apiMock.createSession,
  sendMessage: apiMock.sendMessage,
  loadSlashCommandCatalog: apiMock.loadSlashCommandCatalog,
  executeSlashCommand: apiMock.executeSlashCommand,
  abortAgent: apiMock.abortAgent,
  renameAgent: apiMock.renameAgent,
  stopAgent: apiMock.stopAgent,
  deleteAgent: apiMock.deleteAgent,
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
  SOCKET_PROBE_TIMEOUT_MS,
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
  apiMock.renameAgent.mockReset();
  apiMock.stopAgent.mockReset();
  apiMock.deleteAgent.mockReset();
  apiMock.respondToAttention.mockReset();
  apiMock.signOut.mockReset().mockResolvedValue(undefined);
  pushMock.revokePushLocally.mockReset().mockResolvedValue(undefined);
  pushMock.reclaimPushSubscription.mockReset().mockResolvedValue(undefined);
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

  // The deep link is a one-time launch instruction, not a standing preference.
  // Before this, the ref that caches it was never cleared, so every later
  // re-initialize (socket backoff, online/visibilitychange, a manual
  // reconnect) reapplied it and silently snapped the user back to whatever
  // notification they tapped, however long ago.
  it("does not re-apply a notification deep link on a later reconnect", async () => {
    window.history.replaceState(null, "", "/?agent=agent-b");
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-b"));

    // The user moves on from the deep-linked session.
    await act(() => result.current.selectAgent("agent-a"));
    expect(result.current.selectedAgentId).toBe("agent-a");

    // A reconnect re-runs the whole bootstrap flow.
    act(() => result.current.reconnect());
    await waitFor(() => expect(apiMock.bootstrap).toHaveBeenCalledTimes(2));

    expect(result.current.selectedAgentId).toBe("agent-a");
  });

  // The consuming read sits after the `await api.bootstrap(...)`, deliberately:
  // a bootstrap that never succeeds must leave the deep link unconsumed, so a
  // later attempt can still honor it. This pins that placement.
  it("still honors the deep link on the first bootstrap that actually succeeds", async () => {
    window.history.replaceState(null, "", "/?agent=agent-b");
    apiMock.bootstrap
      .mockRejectedValueOnce(new Error("bootstrap unavailable"))
      .mockResolvedValueOnce(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.connection).toBe("offline"));

    act(() => result.current.reconnect());

    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-b"));
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

  /* Three close reasons mean the credential is gone, and for a revoked device
     this frame is the only word it gets: the revoking device runs signOut()
     locally, every other tab bound to the reaped sessions sees nothing but the
     1008. Unmatched, a reason read as an ordinary drop and the app stayed
     interactive through a backoff and a wasted socket attempt while every
     mutation 401'd. */
  it.each(["Session expired", "Device revoked", "Signed out"])("turns a %s websocket close into centralized auth reset", async (reason) => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    act(() => socket.close(1008, reason));

    expect(result.current.authRequired).toBe(true);
    expect(result.current.snapshots).toEqual({});
    expect(result.current.catalog.agents).toEqual([]);
  });

  /* "offline" is a claim about the transport, and nothing but a re-attach can
     retract it — plain event frames never touch the socket phase. So a
     transcript that would not load used to leave a live socket behind a
     "Connection lost" banner offering a Reconnect that would close it. */
  it("keeps the connection live when the first transcript fails but the socket is open", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new apiMock.ApiError(408, "Request timed out"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.error).toBeTruthy());

    expect(result.current.connection).toBe("live");
  });

  it("still reports offline when the transcript fails and the socket never opened", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new apiMock.ApiError(408, "Request timed out"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.error).toBeTruthy());

    expect(result.current.connection).toBe("offline");
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


  /* The bug this pair of tests exists for.
     A device that has paired once keeps a 400-day credential, and a gateway
     restart is supposed to be invisible: bootstrap 401s, the store spends the
     credential on a fresh session, and the reader never sees the token screen.
     It never happened. decode() runs the central onUnauthorized handlers
     synchronously before throwing, resetForUnauthorized() bumps
     initializationGeneration and aborts the in-flight controller, and both
     guards at the top of initialize()'s catch then returned early — so
     api.resume() was unreachable. Every restart asked for the token again.
     The old mocks rejected without firing the handler, so no test could see it. */
  it("spends the device credential on a restart instead of asking for the token again", async () => {
    apiMock.bootstrap
      .mockImplementationOnce(unauthorized())
      .mockResolvedValueOnce(bootstrap([summary("agent-a")]));
    apiMock.resume.mockResolvedValueOnce({ csrfToken: "csrf-resumed" });
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));
    expect(apiMock.resume).toHaveBeenCalledTimes(1);
    expect(result.current.authRequired).toBe(false);
    expect(apiMock.pair).not.toHaveBeenCalled();
  });

  it("falls through to pairing when the device credential is gone", async () => {
    apiMock.bootstrap.mockImplementation(unauthorized());
    apiMock.resume.mockImplementation(unauthorized("No device credential"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.authRequired).toBe(true));
    // Attempted, not attempted exactly once: the credential is tried once per
    // initialize, and a retry that re-initializes is entitled to try again.
    expect(apiMock.resume).toHaveBeenCalled();
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
    // Sign-out kills the wake capability on both sides. A TTL lapse
    // deliberately kills neither.
    expect(pushMock.revokePushLocally).toHaveBeenCalled();
    expect(result.current.authRequired).toBe(true);
    expect(result.current.hadSession).toBe(false);
    expect(result.current.snapshots).toEqual({});
    expect(result.current.csrfToken).toBe("");
  });

  it("gives up the browser subscription even when the logout request fails", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    apiMock.signOut.mockRejectedValue(new Error("gateway unreachable"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(async () => { await result.current.signOut(); });

    expect(pushMock.revokePushLocally).toHaveBeenCalled();
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

  /* A fast double-tap between two cold sessions. openAgent()'s trailing
     cleanup detaches any subscription that has no snapshot yet, to prune
     abandoned in-flight selections. Before the generation guard, two
     concurrent openAgent calls shared no way to tell "abandoned" apart from
     "still loading, but winning": whichever call's fetch resolved first ran
     that cleanup and saw the *other* call's subscription with no snapshot —
     even when that other call was the one the user actually landed on. Its
     live stream was silently detached, with no visible sign beyond realtime
     updates simply stopping. */
  it("does not detach the winning session's stream when a superseded openAgent call resolves first", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-r"), summary("agent-a"), summary("agent-b")]));
    const deferredA = deferred<AgentSnapshot>();
    const deferredB = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockImplementation((id: string) => {
      if (id === "agent-a") return deferredA.promise;
      if (id === "agent-b") return deferredB.promise;
      return Promise.resolve(snapshot(id));
    });
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-r"));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    // Tap agent-a, then tap agent-b immediately after — before agent-a's
    // snapshot load finishes. agent-b is what the user actually lands on.
    let selectingA!: Promise<void>;
    let selectingB!: Promise<void>;
    act(() => {
      selectingA = result.current.selectAgent("agent-a");
      selectingB = result.current.selectAgent("agent-b");
    });
    expect(result.current.selectedAgentId).toBe("agent-b");

    // The superseded call's (agent-a's) fetch resolves first — the ordering
    // that lets its trailing cleanup see agent-b's subscription with no
    // snapshot yet, and wrongly detach it, without the generation guard.
    await act(async () => {
      deferredA.resolve(snapshot("agent-a"));
      await selectingA;
    });
    await act(async () => {
      deferredB.resolve(snapshot("agent-b"));
      await selectingB;
    });

    expect(result.current.selectedAgentId).toBe("agent-b");
    expect(result.current.snapshots["agent-b"]).toBeDefined();
    const detachedWinner = socket.sent.some((frame) => {
      const parsed = JSON.parse(frame) as { type?: string; streamId?: string };
      return parsed.type === "detach" && parsed.streamId === "agent:agent-b";
    });
    expect(detachedWinner).toBe(false);
  });

  /* A transcript that fails must say so. Before this, a thrown loadAgent left
     `snapshots[id]` undefined forever and the panel showed its spinner with no
     retry and no failed state — so a clean 15s timeout was indistinguishable
     from the permanent stream_gone deadlock. */
  it("records why a transcript failed instead of leaving it loading", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new apiMock.ApiError(408, "The request timed out"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.transcriptErrors["agent-a"]).toBe("Loading the transcript timed out."));
    expect(result.current.snapshots["agent-a"]).toBeUndefined();
  });

  it("retries a failed transcript and clears the failure when it lands", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new apiMock.ApiError(408, "The request timed out"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.transcriptErrors["agent-a"]).toBeDefined());

    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    await act(async () => { await result.current.retryTranscript("agent-a"); });

    expect(result.current.snapshots["agent-a"]).toBeDefined();
    expect(result.current.transcriptErrors["agent-a"]).toBeUndefined();
  });

  it("says the gateway is unreachable when the request never got that far", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.transcriptErrors["agent-a"]).toBe("Could not reach the gateway."));
  });

  it("stays quiet when the load was aborted because the session moved on", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockRejectedValue(new DOMException("Session changed", "AbortError"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(apiMock.loadAgent).toHaveBeenCalled());
    // An abort is the app moving on, not a failure to report.
    await waitFor(() => expect(result.current.transcriptErrors["agent-a"]).toBeUndefined());
  });

  /* The transcript-never-loads deadlock, from the client's side.

     "stream_gone" used to be terminal whatever the reason. For an agent that
     merely had no stream yet — the ordinary state right after a gateway
     restart, when the hub holds `catalog` and nothing else — that was
     unrecoverable: the agent is evicted, the HTTP snapshot that lands next is
     refused because the agent is "gone", and only a WebSocket snapshot clears
     that flag, which needs the attach the eviction just discarded. The spinner
     never resolves, and switching sessions does not help because that path is
     HTTP too.

     Catalog membership is what separates the two meanings: a deleted agent
     leaves the catalog, one that is not ready yet does not. */
  const attachCount = (socket: MockWebSocket, streamId: string) =>
    socket.sent.filter((frame) => frame.includes('"attach"') && frame.includes(streamId)).length;

  it("retries the attach when a still-listed agent reports stream_gone", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    const before = attachCount(socket, "agent:agent-a");
    act(() => socket.message({
      type: "detached", version: 1, streamId: "agent:agent-a", reason: "stream_gone",
    }));

    // Still listed, so this was not a deletion: attach again rather than write
    // the agent off. Counted across the frame, because the socket re-attaches
    // every subscription on open anyway.
    expect(attachCount(socket, "agent:agent-a")).toBeGreaterThan(before);
    expect(result.current.snapshots["agent-a"]).toBeDefined();
  });

  it("keeps accepting HTTP snapshots for a still-listed agent it gave up on", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    const http = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockReturnValue(http.promise);
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(apiMock.loadAgent).toHaveBeenCalledWith("agent-a", expect.anything()));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    // Past the retry cap, so the agent really is written off.
    const gone = { type: "detached", version: 1, streamId: "agent:agent-a", reason: "stream_gone" };
    act(() => socket.message(gone));
    act(() => socket.message(gone));
    expect(result.current.snapshots["agent-a"]).toBeUndefined();

    // ...and the transcript still resolves, because the catalog says the agent
    // exists. Without this the spinner is permanent: nothing else can clear the
    // flag, and no attach is left to deliver the snapshot that would.
    http.resolve(snapshot("agent-a"));
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
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

  it("loads a snapshot for an unopened session before renaming it", async () => {
    // Renaming is reachable from the drawer for a session the user has never
    // opened, so the revision the mutation must echo is not in the store yet.
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === "agent-b" ? 7 : 1)));
    apiMock.renameAgent.mockResolvedValue({ accepted: true, requestId: "request", revision: 8 });
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(() => result.current.rename("agent-b", "Renamed from the drawer"));

    expect(apiMock.renameAgent).toHaveBeenCalledWith("agent-b", "csrf", 7, "Renamed from the drawer");
    expect(result.current.snapshots["agent-b"].revision).toBe(8);
    // Renaming another session must not move the user off the one they are in.
    expect(result.current.selectedAgentId).toBe("agent-a");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a refused rename and leaves the revision alone", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a", 3));
    apiMock.renameAgent.mockRejectedValue(new apiMock.ApiError(403, "Action is not allowed"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(async () => {
      await expect(result.current.rename("agent-a", "Nope")).rejects.toMatchObject({ status: 403 });
    });

    expect(result.current.error).toBe("Action is not allowed");
    expect(result.current.snapshots["agent-a"].revision).toBe(3);
  });

  it("stops a session the user has not opened without moving their selection", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === "agent-b" ? 4 : 1)));
    apiMock.stopAgent.mockResolvedValue({ accepted: true, requestId: "request", revision: 5 });
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(() => result.current.stop("agent-b"));

    expect(apiMock.stopAgent).toHaveBeenCalledWith("agent-b", "csrf", 4);
    expect(result.current.snapshots["agent-b"].revision).toBe(5);
    expect(result.current.selectedAgentId).toBe("agent-a");
  });

  it("drops the deleted session's snapshot and carries the typed name through", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === "agent-b" ? 6 : 1)));
    apiMock.deleteAgent.mockResolvedValue({ accepted: true, requestId: "request", revision: 7 });
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(() => result.current.deleteSession("agent-b", "agent-b"));

    expect(apiMock.deleteAgent).toHaveBeenCalledWith("agent-b", "csrf", 6, "agent-b");
    // No revision is recorded for an agent that no longer exists.
    expect(result.current.snapshots["agent-b"]).toBeUndefined();
    expect(result.current.selectedAgentId).toBe("agent-a");
    expect(result.current.error).toBeNull();
  });

  it("keeps the session when the delete is refused", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a", 2));
    apiMock.deleteAgent.mockRejectedValue(new apiMock.ApiError(403, "That is not this session's name"));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedSnapshot?.agentId).toBe("agent-a"));

    await act(async () => {
      await expect(result.current.deleteSession("agent-a", "wrong")).rejects.toMatchObject({ status: 403 });
    });

    expect(result.current.error).toBe("That is not this session's name");
    expect(result.current.snapshots["agent-a"].revision).toBe(2);
  });

  it("moves the selection off a session that leaves the catalog", async () => {
    // Deleted from here, or ended anywhere else — either way the app must not
    // be left pointing at a row the catalog no longer has.
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-a"));

    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.message({
      type: "event",
      version: 1,
      envelope: {
        version: 1,
        streamId: "catalog",
        epoch: "epoch",
        seq: 2,
        emittedAt: "2026-01-01T00:00:00.000Z",
        event: { kind: "catalog.replaced", payload: { revision: 2, agents: [summary("agent-b")] } },
      },
    }));

    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-b"));
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

/* The phone was asleep, and the socket it comes back with reports OPEN whether
   or not anything is still listening on the other end. Nothing in the browser
   distinguishes those two, so the app has to ask. */
describe("GatewayProvider wake probe", () => {
  function wake(visibility: "visible" | "hidden" = "visible") {
    Object.defineProperty(document, "visibilityState", { value: visibility, configurable: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  }

  function frames(socket: { sent: string[] }) {
    return socket.sent.map((value) => JSON.parse(value) as { type: string; streamId?: string });
  }

  it("pings and re-attaches every stream when the app comes back to the front", async () => {
    vi.useFakeTimers();
    renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    socket.sent.length = 0;

    wake();

    expect(frames(socket)).toContainEqual({ type: "ping", version: 1 });
    // Re-attaching is how the transcript catches up on whatever arrived while
    // the phone was away: the cursor rides along and the gateway replays.
    expect(frames(socket)).toContainEqual(expect.objectContaining({ type: "attach", streamId: "catalog" }));

    act(() => socket.message({ type: "pong", version: 1 }));
    act(() => { vi.advanceTimersByTime(SOCKET_PROBE_TIMEOUT_MS); });
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
  });

  /* The bug this exists for: before the probe, a socket that came back dead
     but OPEN was found out by the steady ping loop, up to an interval plus a
     pong timeout later. Half a minute of a stale transcript that looks live. */
  it("closes a woken socket that never answers, long before the steady ping would", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    wake();
    act(() => { vi.advanceTimersByTime(SOCKET_PROBE_TIMEOUT_MS); });

    expect(SOCKET_PROBE_TIMEOUT_MS).toBeLessThan(SOCKET_PING_INTERVAL_MS + SOCKET_PONG_TIMEOUT_MS);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(result.current.connection).toBe("offline");
  });

  // iOS backgrounds the page for its own photo picker and share sheet and
  // hands it straight back. That is not a wake the user made.
  it("treats rapid hide/show cycles as one wake", async () => {
    vi.useFakeTimers();
    renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    socket.sent.length = 0;

    wake();
    wake("hidden");
    wake();

    expect(frames(socket).filter((frame) => frame.type === "ping")).toHaveLength(1);
  });

  it("probes nothing while the page is hidden", async () => {
    vi.useFakeTimers();
    renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    socket.sent.length = 0;

    wake("hidden");

    expect(frames(socket)).toHaveLength(0);
  });

  // A socket that is already gone needs the bootstrap, not a ping: the
  // bootstrap is what surfaces an expired session as a 401 and routes to
  // pairing instead of retrying a connection that will never authenticate.
  it("still runs the bootstrap when the socket is not open", async () => {
    vi.useFakeTimers();
    renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    const bootstraps = apiMock.bootstrap.mock.calls.length;
    act(() => socket.close());

    wake();
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.bootstrap.mock.calls.length).toBeGreaterThan(bootstraps);
  });

  it("does not reconnect on wake once the session is gone", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await act(async () => { await Promise.resolve(); });
    act(() => MockWebSocket.instances[0].open());
    act(() => apiMock.unauthorized?.());
    expect(result.current.authRequired).toBe(true);
    const bootstraps = apiMock.bootstrap.mock.calls.length;
    const sockets = MockWebSocket.instances.length;

    wake();
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.bootstrap.mock.calls.length).toBe(bootstraps);
    expect(MockWebSocket.instances).toHaveLength(sockets);
  });
});

/* Typing a 43-character token into a phone is the worst step in setting this
   up, and often two: iOS can give the installed app storage separate from
   Safari's, so the same token gets typed again. A link carries it instead. */
describe("GatewayProvider pairing links", () => {
  const TOKEN = "9hIe-0eiCAcRa4iGOGWCrqOMD5DQ_fwD1e7jND4MO9I";

  function openWithLink(fragment = `#pair=${TOKEN}`) {
    window.history.replaceState(null, "", `/${fragment}`);
  }

  it("pairs from the link, and clears it out of the URL first", async () => {
    openWithLink();
    apiMock.bootstrap
      .mockImplementationOnce(unauthorized())
      .mockResolvedValueOnce(bootstrap([summary("agent-a")]));
    apiMock.resume.mockImplementation(unauthorized("No device credential"));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    // The token is out of the address bar from the first render, before any
    // request has been made — not after the pairing succeeds.
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(result.current.authRequired).toBe(false));
    expect(apiMock.pair).toHaveBeenCalledWith(TOKEN, expect.any(String));
  });

  // The device credential is the cheaper answer and belongs first: a phone
  // that is already paired should not spend a link at all.
  it("prefers a working device credential over the link", async () => {
    openWithLink();
    apiMock.bootstrap
      .mockImplementationOnce(unauthorized())
      .mockResolvedValueOnce(bootstrap([summary("agent-a")]));
    apiMock.resume.mockResolvedValueOnce({ csrfToken: "csrf-resumed" });
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.authRequired).toBe(false));
    expect(apiMock.pair).not.toHaveBeenCalled();
  });

  it("says why a stale link failed, on the screen that comes next", async () => {
    openWithLink();
    apiMock.bootstrap.mockImplementation(unauthorized());
    apiMock.resume.mockImplementation(unauthorized("No device credential"));
    apiMock.pair.mockImplementation(unauthorized("Pairing failed"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.authRequired).toBe(true));
    expect(result.current.linkError).toBe("Pairing failed");
  });

  /* Spent once, whatever happens to it. A token that failed will fail again,
     and retrying it on every re-initialize would burn the five-per-minute
     pairing budget for the whole address. */
  it("does not spend a failed link twice", async () => {
    openWithLink();
    apiMock.bootstrap.mockImplementation(unauthorized());
    apiMock.resume.mockImplementation(unauthorized("No device credential"));
    apiMock.pair.mockImplementation(unauthorized("Pairing failed"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.authRequired).toBe(true));
    const attempts = apiMock.pair.mock.calls.length;

    await act(async () => { await result.current.reconnect(); });
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.pair.mock.calls.length).toBe(attempts);
  });

  /* The ordinary case on a phone: the app is already open on the pairing
     screen, and the camera hands the tab a URL that differs only by its
     fragment. The browser does not reload for that, so the read during the
     first render never happens again — found by driving a real browser, where
     the second visit did nothing at all. */
  it("takes a link that arrives while the pairing screen is already up", async () => {
    // Two 401s: one that puts the pairing screen up, and one when the link
    // arrives and the app tries again before spending it.
    apiMock.bootstrap
      .mockImplementationOnce(unauthorized())
      .mockImplementationOnce(unauthorized())
      .mockResolvedValueOnce(bootstrap([summary("agent-a")]));
    apiMock.resume.mockImplementation(unauthorized("No device credential"));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.authRequired).toBe(true));

    act(() => {
      window.history.replaceState(null, "", `/#pair=${TOKEN}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => expect(apiMock.pair).toHaveBeenCalledWith(TOKEN, expect.any(String)));
    expect(window.location.hash).toBe("");
  });

  // A link that arrives at a device that is already paired has nothing to do
  // but get out of the URL. Holding the token for a later 401 would spend a
  // stale secret hours after whoever scanned it walked away.
  it("only clears a link that arrives at an already-paired device", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-a"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.authRequired).toBe(false));

    act(() => {
      window.history.replaceState(null, "", `/#pair=${TOKEN}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(window.location.hash).toBe("");
    expect(apiMock.pair).not.toHaveBeenCalled();
  });

  it("ignores a fragment that is not a pairing link", async () => {
    openWithLink("#section");
    apiMock.bootstrap.mockImplementation(unauthorized());
    apiMock.resume.mockImplementation(unauthorized("No device credential"));

    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });

    await waitFor(() => expect(result.current.authRequired).toBe(true));
    expect(apiMock.pair).not.toHaveBeenCalled();
    expect(result.current.linkError).toBeNull();
    // And a fragment that means something to someone else is left alone.
    expect(window.location.hash).toBe("#section");
  });
});

describe("GatewayProvider automatic transcript loading", () => {
  function replaceCatalog(socket: MockWebSocket, ids: string[], seq = 2, full = false) {
    const catalog = { revision: seq, agents: ids.map(summary) };
    socket.message(full ? {
      type: "snapshot", version: 1, streamId: "catalog", cursor: { epoch: "epoch", seq }, snapshot: catalog,
    } : {
      type: "event", version: 1,
      envelope: {
        version: 1, streamId: "catalog", epoch: "epoch", seq,
        emittedAt: "2026-01-01T00:00:00.000Z",
        event: { kind: "catalog.replaced", payload: catalog },
      },
    });
  }

  it.each([false, true])("loads the fallback selected by a catalog update (full snapshot: %s)", async (full) => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    const pending = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockImplementation((id: string) => id === "agent-b" ? pending.promise : Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
    const socket = MockWebSocket.instances[0];
    act(() => { socket.open(); replaceCatalog(socket, ["agent-b"], 2, full); });
    await waitFor(() => expect(apiMock.loadAgent).toHaveBeenCalledWith("agent-b", undefined));
    act(() => replaceCatalog(socket, ["agent-b"], 3, full));
    expect(apiMock.loadAgent.mock.calls.filter(([id]) => id === "agent-b")).toHaveLength(1);
    expect(socket.sent.some((frame) => JSON.parse(frame).streamId === "agent:agent-b")).toBe(true);
    await act(async () => { pending.resolve(snapshot("agent-b")); });
    expect(result.current.selectedSnapshot?.agentId).toBe("agent-b");
  });

  it("leaves a failed fallback on Retry without retrying on unrelated catalog changes", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    apiMock.loadAgent.mockImplementation((id: string) => id === "agent-b"
      ? Promise.reject(new Error("Transcript unavailable")) : Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
    const socket = MockWebSocket.instances[0];
    act(() => { socket.open(); replaceCatalog(socket, ["agent-b"]); });
    await waitFor(() => expect(result.current.transcriptErrors["agent-b"]).toBeDefined());
    act(() => replaceCatalog(socket, ["agent-b"], 3));
    expect(apiMock.loadAgent.mock.calls.filter(([id]) => id === "agent-b")).toHaveLength(1);
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-b"));
    await act(() => result.current.retryTranscript("agent-b"));
    expect(result.current.selectedSnapshot?.agentId).toBe("agent-b");
    expect(result.current.transcriptErrors["agent-b"]).toBeUndefined();
  });

  it("does not duplicate a tap's pending load when React commits the selection", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    const pending = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockImplementation((id: string) => id === "agent-b" ? pending.promise : Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
    let selecting!: Promise<void>;
    act(() => { selecting = result.current.selectAgent("agent-b"); });
    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-b"));
    expect(apiMock.loadAgent.mock.calls.filter(([id]) => id === "agent-b")).toHaveLength(1);
    await act(async () => { pending.resolve(snapshot("agent-b")); await selecting; });
  });

  it("keeps the fallback subscribed when an earlier tap finishes loading", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("root"), summary("agent-a"), summary("agent-b")]));
    const a = deferred<AgentSnapshot>();
    const b = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockImplementation((id: string) => id === "agent-a" ? a.promise
      : id === "agent-b" ? b.promise : Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.snapshots.root).toBeDefined());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    let selecting!: Promise<void>;
    act(() => { selecting = result.current.selectAgent("agent-a"); });
    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-a"));
    act(() => replaceCatalog(socket, ["agent-b"]));
    await waitFor(() => expect(apiMock.loadAgent).toHaveBeenCalledWith("agent-b", undefined));
    await act(async () => { a.resolve(snapshot("agent-a")); await selecting; });
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) =>
      frame.type === "detach" && frame.streamId === "agent:agent-b")).toEqual([]);
    await act(async () => { b.resolve(snapshot("agent-b")); });
    expect(result.current.selectedSnapshot?.agentId).toBe("agent-b");
  });

  it("reclaims the push subscription after an auth reset even when the token is reused", async () => {
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(pushMock.reclaimPushSubscription).toHaveBeenCalledTimes(1));
    act(() => apiMock.unauthorized?.());
    await act(() => result.current.pair("test-token"));
    expect(pushMock.reclaimPushSubscription).toHaveBeenCalledTimes(2);
  });

  it("discards an automatic load after sign-out and fetches anew after pairing", async () => {
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-a"), summary("agent-b")]));
    const pending = deferred<AgentSnapshot>();
    apiMock.loadAgent.mockImplementation((id: string) => id === "agent-b" ? pending.promise : Promise.resolve(snapshot(id)));
    const { result } = renderHook(() => useGateway(), { wrapper: GatewayProvider });
    await waitFor(() => expect(result.current.snapshots["agent-a"]).toBeDefined());
    const socket = MockWebSocket.instances[0];
    act(() => { socket.open(); replaceCatalog(socket, ["agent-b"]); });
    await waitFor(() => expect(result.current.selectedAgentId).toBe("agent-b"));
    act(() => apiMock.unauthorized?.());
    await act(async () => { pending.resolve(snapshot("agent-b")); });
    expect(result.current.snapshots).toEqual({});
    expect(result.current.transcriptErrors).toEqual({});
    apiMock.bootstrap.mockResolvedValue(bootstrap([summary("agent-b")]));
    apiMock.loadAgent.mockResolvedValue(snapshot("agent-b", 2));
    await act(() => result.current.pair("test-token"));
    expect(result.current.selectedSnapshot?.revision).toBe(2);
  });
});
