import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://gateway.example.test";

interface WorkerHarness {
  self: {
    location: { origin: string };
    registration: { showNotification: ReturnType<typeof vi.fn> };
    clients: {
      matchAll: ReturnType<typeof vi.fn>;
      openWindow: ReturnType<typeof vi.fn>;
      claim: ReturnType<typeof vi.fn>;
    };
    navigator: {
      setAppBadge: ((count?: number) => Promise<void>) | undefined;
      clearAppBadge: (() => Promise<void>) | undefined;
    };
    skipWaiting: ReturnType<typeof vi.fn>;
  };
  dispatch(type: string, event: Record<string, unknown>): Promise<void>;
}

/**
 * Evaluates the real `public/sw.js` against a stubbed worker global. The
 * worker registers in production only (`src/web/main.tsx`), so nothing else in
 * the suite ever executes it.
 */
function loadWorker(navigatorOverrides: Partial<WorkerHarness["self"]["navigator"]> = {}): WorkerHarness {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const self = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      handlers.set(type, handler);
    },
    location: { origin: ORIGIN },
    registration: { showNotification: vi.fn(async () => {}) },
    clients: {
      matchAll: vi.fn(async () => [] as Array<{ url: string; focus: () => Promise<void> }>),
      openWindow: vi.fn(async () => {}),
      claim: vi.fn(),
    },
    navigator: {
      setAppBadge: vi.fn(async () => {}) as WorkerHarness["self"]["navigator"]["setAppBadge"],
      clearAppBadge: vi.fn(async () => {}) as WorkerHarness["self"]["navigator"]["clearAppBadge"],
      ...navigatorOverrides,
    },
    skipWaiting: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "caches", "fetch", source)(self, { open: vi.fn(), keys: vi.fn(), match: vi.fn() }, vi.fn());

  return {
    self: self as unknown as WorkerHarness["self"],
    async dispatch(type, event) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`The worker registered no ${type} handler`);
      const settled: Array<Promise<unknown>> = [];
      handler({ ...event, waitUntil: (value: Promise<unknown>) => settled.push(value) });
      await Promise.all(settled);
    },
  };
}

function pushEvent(payload: unknown) {
  return { data: { json: () => payload } };
}

describe("service worker push handling", () => {
  it("shows the pushed title and body", async () => {
    const worker = loadWorker();
    await worker.dispatch("push", pushEvent({
      version: 1,
      title: "release-planning",
      body: "Waiting on your decision",
      kind: "dialog",
      agentId: "agent-7",
      attentionId: "attention-3",
      badge: 2,
    }));

    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      "release-planning",
      expect.objectContaining({
        body: "Waiting on your decision",
        tag: "attention:agent-7",
        data: { agentId: "agent-7" },
      }),
    );
  });

  // The app is closed exactly when this matters, so the worker owns the badge;
  // one only written by the running app would be stale on arrival.
  it("sets the app badge from the payload without waiting for the app", async () => {
    const worker = loadWorker();
    await worker.dispatch("push", pushEvent({ title: "a", body: "b", badge: 3 }));
    expect(worker.self.navigator.setAppBadge).toHaveBeenCalledWith(3);

    const cleared = loadWorker();
    await cleared.dispatch("push", pushEvent({ title: "a", body: "b", badge: 0 }));
    expect(cleared.self.navigator.clearAppBadge).toHaveBeenCalled();
  });

  it("still notifies when the badge API is missing or rejects", async () => {
    const missing = loadWorker({ setAppBadge: undefined, clearAppBadge: undefined });
    await missing.dispatch("push", pushEvent({ title: "a", body: "b", badge: 1 }));
    expect(missing.self.registration.showNotification).toHaveBeenCalled();

    const rejecting = loadWorker({ setAppBadge: () => Promise.reject(new Error("not allowed")) });
    await rejecting.dispatch("push", pushEvent({ title: "a", body: "b", badge: 1 }));
    expect(rejecting.self.registration.showNotification).toHaveBeenCalled();
  });

  // A worker that receives a push and shows nothing gets its subscription
  // revoked by the browser, so a garbled payload must still surface something.
  it("falls back to a generic notification for an unreadable payload", async () => {
    for (const event of [
      { data: { json: () => { throw new SyntaxError("not json"); } } },
      { data: null },
      pushEvent(["array"]),
      pushEvent({ title: "   ", body: 42 }),
    ]) {
      const worker = loadWorker();
      await worker.dispatch("push", event);
      expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
        "Prime Agent",
        expect.objectContaining({ body: "A session needs your attention", tag: "attention" }),
      );
    }
  });

  it("normalizes a nonsensical badge count to a clear", async () => {
    const worker = loadWorker();
    await worker.dispatch("push", pushEvent({ title: "a", body: "b", badge: -4 }));
    expect(worker.self.navigator.setAppBadge).not.toHaveBeenCalled();
    expect(worker.self.navigator.clearAppBadge).toHaveBeenCalled();
  });
});

describe("service worker notification clicks", () => {
  function notification(agentId: string | null) {
    return { close: vi.fn(), data: agentId === null ? null : { agentId } };
  }

  it("opens the app at the agent that wants attention when nothing is running", async () => {
    const worker = loadWorker();
    const opened = notification("agent 7");
    await worker.dispatch("notificationclick", { notification: opened });

    expect(opened.close).toHaveBeenCalled();
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith("/?agent=agent%207");
  });

  it("opens the app root when the notification names no agent", async () => {
    const worker = loadWorker();
    await worker.dispatch("notificationclick", { notification: notification(null) });
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith("/");
  });

  // A second window would abandon the socket and scroll position the user
  // already has.
  it("focuses an existing window instead of opening another", async () => {
    const worker = loadWorker();
    const focus = vi.fn(async () => {});
    worker.self.clients.matchAll.mockResolvedValue([{ url: `${ORIGIN}/`, focus }]);

    await worker.dispatch("notificationclick", { notification: notification("agent-7") });

    expect(focus).toHaveBeenCalled();
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled();
  });
});
