import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import {
  currentPushSubscription,
  decodeApplicationServerKey,
  disablePush,
  enablePush,
  pushSupported,
  readPushState,
  reclaimPushSubscription,
  revokePushLocally,
} from "./push";

const APPLICATION_SERVER_KEY =
  "BF1JW243veaons7uO0bcdtRHXVUTVJ74A_OzX7wiGhY114OpWvn0BOBrfXu2AhV3cmc0Nrb_LIRZHbFY4L8Xmgw";

interface FakeSubscription {
  endpoint: string;
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => { endpoint: string; keys?: { p256dh?: string; auth?: string } };
}

function fakeSubscription(overrides: Partial<ReturnType<FakeSubscription["toJSON"]>> = {}): FakeSubscription {
  const endpoint = overrides.endpoint ?? "https://push.example.test/device";
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU", auth: "3v0fHqQhH3xQ1r6mB3dOsg" },
      ...overrides,
    }),
  };
}

const pushManager = {
  getSubscription: vi.fn(async () => null as FakeSubscription | null),
  subscribe: vi.fn(async () => fakeSubscription()),
};

function installBrowser(options: {
  permission?: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
  serviceWorker?: boolean;
  pushManagerSupported?: boolean;
} = {}) {
  const permission = options.permission ?? "default";
  if (options.pushManagerSupported === false) {
    vi.stubGlobal("PushManager", undefined);
  } else {
    vi.stubGlobal("PushManager", class {});
  }
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: options.requestPermission ?? vi.fn(async () => permission),
  });
  const registration = { pushManager };
  if (options.serviceWorker === false) {
    vi.stubGlobal("navigator", {});
  } else {
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });
  }
}

beforeEach(() => {
  apiMock.subscribeToPush.mockReset().mockResolvedValue({ accepted: true, requestId: "r" });
  apiMock.unsubscribeFromPush.mockReset().mockResolvedValue({ accepted: true, requestId: "r" });
  pushManager.getSubscription.mockReset().mockResolvedValue(null);
  pushManager.subscribe.mockReset().mockImplementation(async () => fakeSubscription());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeApplicationServerKey", () => {
  // Safari rejects the base64url string form outright, so the raw bytes matter.
  it("turns the gateway's base64url key into the 65 raw bytes subscribe wants", () => {
    const bytes = decodeApplicationServerKey(APPLICATION_SERVER_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
  });
});

describe("pushSupported", () => {
  it("is false without a service worker or a PushManager", () => {
    installBrowser({ serviceWorker: false });
    expect(pushSupported()).toBe(false);

    installBrowser({ pushManagerSupported: false });
    expect(pushSupported()).toBe(false);

    installBrowser();
    expect(pushSupported()).toBe(true);
  });
});

describe("readPushState", () => {
  it("reports each state a device can honestly be in", async () => {
    installBrowser({ serviceWorker: false });
    await expect(readPushState({ enabled: true })).resolves.toBe("unsupported");

    installBrowser();
    await expect(readPushState(null)).resolves.toBe("unconfigured");
    await expect(readPushState({ enabled: false })).resolves.toBe("unconfigured");
    await expect(readPushState({ enabled: true })).resolves.toBe("off");

    pushManager.getSubscription.mockResolvedValue(fakeSubscription());
    await expect(readPushState({ enabled: true })).resolves.toBe("on");

    // Denied outranks having a subscription: the page cannot re-prompt, so the
    // control must say so rather than offer a switch.
    installBrowser({ permission: "denied" });
    await expect(readPushState({ enabled: true })).resolves.toBe("denied");
  });
});

describe("enablePush", () => {
  /* The regression this guards is a hang, not an error.
     `serviceWorker.ready` never rejects — with nothing registered it simply
     never settles. Asking for permission first therefore spent the one prompt a
     page ever gets and then left the control busy forever with nothing on
     screen. The service worker registers in production builds only, so the dev
     server hit this every time. */
  it("refuses before spending the permission prompt when no worker is registered", async () => {
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    installBrowser({ requestPermission });
    (navigator as unknown as { serviceWorker: { getRegistration: () => Promise<unknown>; ready: Promise<unknown> } })
      .serviceWorker = {
        getRegistration: vi.fn(async () => null),
        // The shape that hangs, so this test fails by timing out if the guard
        // is removed rather than passing on a mock that resolves anyway.
        ready: new Promise(() => {}),
      };

    await expect(enablePush(APPLICATION_SERVER_KEY, "csrf", false)).rejects.toThrow(/service worker/i);
    // A prompt cannot be shown twice, so not asking is the whole point.
    expect(requestPermission).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes with the gateway's key and registers the endpoint", async () => {
    installBrowser({ requestPermission: vi.fn(async () => "granted" as NotificationPermission) });

    await expect(enablePush(APPLICATION_SERVER_KEY, "csrf", false)).resolves.toBe("on");
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(apiMock.subscribeToPush).toHaveBeenCalledWith("csrf", {
      endpoint: "https://push.example.test/device",
      keys: { p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU", auth: "3v0fHqQhH3xQ1r6mB3dOsg" },
    }, false);
  });

  it("reports a refused prompt without touching the gateway", async () => {
    installBrowser({ requestPermission: vi.fn(async () => "denied" as NotificationPermission) });
    await expect(enablePush(APPLICATION_SERVER_KEY, "csrf", false)).resolves.toBe("denied");
    expect(apiMock.subscribeToPush).not.toHaveBeenCalled();
  });

  // An old subscription is bound to whichever key created it, so a rotated
  // VAPID pair would leave a subscription the gateway can never encrypt for.
  it("replaces an existing subscription rather than reusing it", async () => {
    const stale = fakeSubscription({ endpoint: "https://push.example.test/stale" });
    pushManager.getSubscription.mockResolvedValue(stale);
    installBrowser({ requestPermission: vi.fn(async () => "granted" as NotificationPermission) });

    await enablePush(APPLICATION_SERVER_KEY, "csrf", false);
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalled();
  });

  // Otherwise the browser keeps a permission with nothing behind it.
  it("gives the subscription back up when the gateway rejects it", async () => {
    const created = fakeSubscription();
    pushManager.subscribe.mockResolvedValue(created);
    apiMock.subscribeToPush.mockRejectedValue(new Error("gateway said no"));
    installBrowser({ requestPermission: vi.fn(async () => "granted" as NotificationPermission) });

    await expect(enablePush(APPLICATION_SERVER_KEY, "csrf", false)).rejects.toThrow("gateway said no");
    expect(created.unsubscribe).toHaveBeenCalled();
  });

  it("refuses an incomplete subscription from the browser", async () => {
    const partial = fakeSubscription({ keys: undefined });
    pushManager.subscribe.mockResolvedValue(partial);
    installBrowser({ requestPermission: vi.fn(async () => "granted" as NotificationPermission) });

    await expect(enablePush(APPLICATION_SERVER_KEY, "csrf", false)).rejects.toThrow("incomplete push subscription");
    expect(apiMock.subscribeToPush).not.toHaveBeenCalled();
    expect(partial.unsubscribe).toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("tells the gateway to forget the endpoint, then drops the browser's own", async () => {
    const existing = fakeSubscription();
    pushManager.getSubscription.mockResolvedValue(existing);
    installBrowser();

    await disablePush("csrf");
    expect(apiMock.unsubscribeFromPush).toHaveBeenCalledWith("csrf", "https://push.example.test/device");
    expect(existing.unsubscribe).toHaveBeenCalled();
  });

  it("does nothing when this device never subscribed", async () => {
    installBrowser();
    await disablePush("csrf");
    expect(apiMock.unsubscribeFromPush).not.toHaveBeenCalled();
  });
});

describe("revokePushLocally", () => {
  // Sign-out revocation runs ahead of the logout request and must not depend
  // on it: the gateway drops its own records when the session dies.
  it("drops the browser subscription without calling the gateway", async () => {
    const existing = fakeSubscription();
    pushManager.getSubscription.mockResolvedValue(existing);
    installBrowser();

    await revokePushLocally();
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(apiMock.unsubscribeFromPush).not.toHaveBeenCalled();
  });

  it("is silent on a browser that cannot push at all", async () => {
    installBrowser({ serviceWorker: false });
    await expect(revokePushLocally()).resolves.toBeUndefined();
    await expect(currentPushSubscription()).resolves.toBeNull();
  });
});

describe("reclaimPushSubscription", () => {
  // Records are bound to the session that created them and sign-out revokes by
  // session id, so a device whose original session expired has to re-claim its
  // subscription or it will outlive the sign-out that was meant to kill it.
  it("re-registers an existing subscription under the current session", async () => {
    pushManager.getSubscription.mockResolvedValue(fakeSubscription());
    installBrowser({ permission: "granted" });

    await reclaimPushSubscription({ enabled: true }, "new-session-csrf", false);
    expect(apiMock.subscribeToPush).toHaveBeenCalledWith("new-session-csrf", {
      endpoint: "https://push.example.test/device",
      keys: { p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU", auth: "3v0fHqQhH3xQ1r6mB3dOsg" },
    }, false);
  });

  // It runs on every launch, so it must never turn into a prompt or a
  // subscription this device did not already have.
  it("asks for nothing when there is nothing to re-claim", async () => {
    installBrowser({ permission: "granted" });
    await reclaimPushSubscription({ enabled: true }, "csrf", false);

    pushManager.getSubscription.mockResolvedValue(fakeSubscription());
    installBrowser({ permission: "default" });
    await reclaimPushSubscription({ enabled: true }, "csrf", false);
    await reclaimPushSubscription({ enabled: false }, "csrf", false);
    await reclaimPushSubscription(null, "csrf", false);

    installBrowser({ permission: "granted" });
    await reclaimPushSubscription({ enabled: true }, "", false);

    expect(apiMock.subscribeToPush).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });
});
