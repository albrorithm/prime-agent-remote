import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AuthService, MAX_TRACKED_PAIR_CLIENTS } from "./auth.js";
import { DEFAULT_VAPID_SUBJECT, type GatewayConfig } from "./config.js";
import type { SlidingWindowLimiter } from "./rate-limit.js";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    allowedOrigins: new Set(["https://agent.example.test"]),
    pairingToken: "correct-token",
    generatedPairingToken: false,
    secureCookie: true,
    backend: "demo",
    primeModule: "compatible-module",
    sessionTtlMs: 60_000,
    generatedWebPush: false,
    webPushSubject: DEFAULT_VAPID_SUBJECT,
    vapidKeysPath: "/dev/null/vapid-keys.json",
    webPushStorePath: "/dev/null/push-subscriptions.json",
    pairingTokenPath: "/dev/null/pairing-token",
    gatewayStatePath: "/dev/null/gateway.json",
    deviceStorePath: "/dev/null/devices.json",
    ...overrides,
  };
}

function request(headers: IncomingMessage["headers"] = {}, remoteAddress = "100.64.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

function response(): { value: ServerResponse; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    headers,
    value: {
      setHeader(name: string, value: string | number | readonly string[]) {
        headers.set(name.toLowerCase(), String(value));
        return this;
      },
    } as unknown as ServerResponse,
  };
}

describe("AuthService", () => {
  it("exchanges the pairing token for a hardened session and validates CSRF", async () => {
    const auth = new AuthService(config());
    const res = response();
    const session = await auth.pair(request({ origin: "https://agent.example.test" }), res.value, "correct-token");
    expect(session).not.toBeNull();
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");

    const cookiePair = cookie.split(";", 1)[0];
    const authenticated = auth.authenticate(request({ cookie: cookiePair }));
    expect(authenticated?.id).toBe(session?.id);
    expect(auth.validateMutation(request({ origin: "https://agent.example.test", "x-csrf-token": session!.csrfToken }), session!)).toBe(true);
    expect(auth.validateMutation(request({ origin: "https://other.example.test", "x-csrf-token": session!.csrfToken }), session!)).toBe(false);
  });

  it("invalidates the session on sign-out and clears the cookie with matching attributes", async () => {
    const auth = new AuthService(config());
    const paired = response();
    const session = (await auth.pair(request({ origin: "https://agent.example.test" }), paired.value, "correct-token"))!;
    const cookiePair = paired.headers.get("set-cookie")!.split(";", 1)[0];

    const cleared = response();
    await auth.signOut(cleared.value, session);

    const cookie = cleared.headers.get("set-cookie")!;
    expect(cookie).toBe("prime_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
    expect(auth.authenticate(request({ cookie: cookiePair }))).toBeNull();
    expect(auth.isSessionActive(session)).toBe(false);
    expect(auth.validateMutation(request({
      origin: "https://agent.example.test",
      "x-csrf-token": session.csrfToken,
    }), session)).toBe(false);
  });

  it("omits Secure from the clearing cookie exactly as pairing does", async () => {
    const auth = new AuthService(config({ secureCookie: false }));
    const paired = response();
    const session = (await auth.pair(request({}, "100.64.0.9"), paired.value, "correct-token"))!;
    const cleared = response();
    await auth.signOut(cleared.value, session);
    expect(cleared.headers.get("set-cookie")).not.toContain("Secure");
    expect(paired.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("ignores malformed cookies", async () => {
    const auth = new AuthService(config());
    expect(() => auth.authenticate(request({ cookie: "prime_web_session=%ZZ" }))).not.toThrow();
    expect(auth.authenticate(request({ cookie: "prime_web_session=%ZZ" }))).toBeNull();
  });

  it("bounds pairing attempts per remote address", async () => {
    const auth = new AuthService(config());
    for (let index = 0; index < 5; index += 1) {
      expect(await auth.pair(request({}, "100.64.0.2"), response().value, "wrong-token")).toBeNull();
    }
    expect(await auth.pair(request({}, "100.64.0.2"), response().value, "correct-token")).toBeNull();
  });

  it("expires sessions and rejects their CSRF tokens", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      const auth = new AuthService(config({ sessionTtlMs: 1_000 }));
      const session = (await auth.pair(request({}, "100.64.0.3"), response().value, "correct-token"))!;
      expect(auth.isSessionActive(session)).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(auth.isSessionActive(session)).toBe(false);
      expect(auth.validateMutation(request({
        origin: "https://agent.example.test",
        "x-csrf-token": session.csrfToken,
      }), session)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps and prunes remote-address rate-limit state", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      const auth = new AuthService(config());
      for (let index = 0; index < MAX_TRACKED_PAIR_CLIENTS + 20; index += 1) {
        await auth.pair(request({}, `100.64.${Math.floor(index / 256)}.${index % 256}`), response().value, "wrong-token");
      }
      const attempts = (auth as unknown as { pairAttempts: SlidingWindowLimiter }).pairAttempts;
      expect(attempts.trackedKeys).toBe(MAX_TRACKED_PAIR_CLIENTS);
      // A previously unseen client is refused while the tracking map is full,
      // even with the correct token.
      expect(await auth.pair(request({}, "100.65.0.1"), response().value, "correct-token")).toBeNull();

      vi.advanceTimersByTime(60_001);
      expect(await auth.pair(request({}, "100.65.0.1"), response().value, "correct-token")).not.toBeNull();
      expect(attempts.trackedKeys).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
