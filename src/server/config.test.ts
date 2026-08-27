import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAPID_SUBJECT, loadConfig } from "./config.js";

const strongToken = "a-random-production-pairing-token-0001";
// A real generated pair; only the decoded lengths (65 and 32 bytes) matter here.
const vapidPublicKey = "BF1JW243veaons7uO0bcdtRHXVUTVJ74A_OzX7wiGhY114OpWvn0BOBrfXu2AhV3cmc0Nrb_LIRZHbFY4L8Xmgw";
const vapidPrivateKey = "IPDx2j8nr-ShPjNWSqXsCAK3fA0W2cM78tjLvtG0jLA";
const vapid = {
  PRIME_WEB_VAPID_PUBLIC_KEY: vapidPublicKey,
  PRIME_WEB_VAPID_PRIVATE_KEY: vapidPrivateKey,
  PRIME_WEB_VAPID_SUBJECT: "mailto:operator@example.test",
};

describe("loadConfig", () => {
  it("requires an explicit origin allowlist in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("PRIME_WEB_ALLOWED_ORIGINS");
  });

  /* A custom port with the default allowlist used to be unpaireable.

     The defaults hardcoded 8787, so following docs/deployment.md with
     PRIME_WEB_PORT=8899 and no explicit origins produced a gateway that
     refused every request from the browser reaching it — the Origin the
     browser sends names the port it actually used, and that was on no list.
     The CLI never hit it because it computes origins from the exposure it
     just configured, which is what made the raw-node path a trap. */
  it("trusts the configured port in the default origin allowlist", () => {
    const value = loadConfig({ NODE_ENV: "test", PRIME_WEB_PORT: "8899" });
    expect(value.port).toBe(8899);
    expect(value.allowedOrigins.has("http://127.0.0.1:8899")).toBe(true);
    expect(value.allowedOrigins.has("http://localhost:8899")).toBe(true);
    // Still no wider than before: the stale hardcoded port is gone, and the
    // dev server stays because the app is developed against it.
    expect(value.allowedOrigins.has("http://127.0.0.1:8787")).toBe(false);
    expect(value.allowedOrigins.has("http://127.0.0.1:5173")).toBe(true);
  });

  it("adds the configured host to the default allowlist, but never a wildcard bind", () => {
    const named = loadConfig({ NODE_ENV: "test", PRIME_WEB_HOST: "gateway.local", PRIME_WEB_PORT: "9000" });
    expect(named.allowedOrigins.has("http://gateway.local:9000")).toBe(true);

    // 0.0.0.0 is not an origin any browser can send, so listing it would only
    // be noise on the allowlist.
    const wildcard = loadConfig({ NODE_ENV: "test", PRIME_WEB_HOST: "0.0.0.0", PRIME_WEB_PORT: "9000" });
    expect(wildcard.allowedOrigins.has("http://0.0.0.0:9000")).toBe(false);
    expect(wildcard.allowedOrigins.has("http://127.0.0.1:9000")).toBe(true);
  });

  it("still lets an explicit allowlist replace the defaults outright", () => {
    const value = loadConfig({
      NODE_ENV: "test",
      PRIME_WEB_PORT: "8899",
      PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test",
    });
    expect(value.allowedOrigins).toEqual(new Set(["https://agent.example.test"]));
  });

  it("lets production run without a configured token, which is then minted and persisted", () => {
    const value = loadConfig({
      NODE_ENV: "production",
      PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test",
    });
    // The value here is a throwaway: index.ts replaces it with the persisted
    // token. What matters is that startup no longer refuses.
    expect(value.generatedPairingToken).toBe(true);
    expect(value.pairingTokenPath).toContain("pairing-token");
  });

  it("still refuses a weak token that was configured on purpose", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test",
      PRIME_WEB_PAIRING_TOKEN: "short-token",
    })).toThrow("at least 32 characters");
  });

  it("accepts canonical HTTP origins and validated production settings", () => {
    const value = loadConfig({
      NODE_ENV: "production",
      PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test",
      PRIME_WEB_PAIRING_TOKEN: strongToken,
      PRIME_WEB_PORT: "9443",
      PRIME_WEB_BACKEND: "prime",
    });
    expect(value.allowedOrigins).toEqual(new Set(["https://agent.example.test"]));
    expect(value.port).toBe(9443);
    expect(value.secureCookie).toBe(true);
    expect(value.backend).toBe("prime");
    expect(value.generatedPairingToken).toBe(false);
  });

  it("keeps startup-generated tokens available outside production", () => {
    const value = loadConfig({ NODE_ENV: "test" });
    expect(value.generatedPairingToken).toBe(true);
    expect(value.pairingToken).toHaveLength(32);
  });

  it("rejects paths, unsupported schemes, empty lists, and invalid ports", () => {
    expect(() => loadConfig({ PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test/path" })).toThrow("Invalid allowed origin");
    expect(() => loadConfig({ PRIME_WEB_ALLOWED_ORIGINS: "file:///tmp/app" })).toThrow("Invalid allowed origin");
    expect(() => loadConfig({ PRIME_WEB_ALLOWED_ORIGINS: ", ," })).toThrow("at least one origin");
    expect(() => loadConfig({ PRIME_WEB_PORT: "70000" })).toThrow("PRIME_WEB_PORT");
    expect(() => loadConfig({ PRIME_WEB_PORT: "8787junk" })).toThrow("PRIME_WEB_PORT");
  });

  it("rejects ambiguous boolean and backend values", () => {
    expect(loadConfig({ PRIME_WEB_SECURE_COOKIE: "false" }).secureCookie).toBe(false);
    expect(loadConfig({ PRIME_WEB_SECURE_COOKIE: "1" }).secureCookie).toBe(true);
    expect(() => loadConfig({ PRIME_WEB_SECURE_COOKIE: "yes" })).toThrow("PRIME_WEB_SECURE_COOKIE");
    expect(() => loadConfig({ PRIME_WEB_SECURE_COOKIE: "TRUE" })).toThrow("PRIME_WEB_SECURE_COOKIE");
    expect(() => loadConfig({ PRIME_WEB_BACKEND: "production" })).toThrow("PRIME_WEB_BACKEND");
    expect(() => loadConfig({ PRIME_WEB_BACKEND: " prime " })).toThrow("PRIME_WEB_BACKEND");
  });

  // Push is an addition, not a requirement: the default deployment has no keys
  // and must still start and run exactly as it did before push existed.
  it("leaves push off when no VAPID keys are configured", () => {
    expect(loadConfig({ NODE_ENV: "test" }).webPush).toBeUndefined();
  });

  it("accepts a complete VAPID configuration", () => {
    const value = loadConfig({ NODE_ENV: "test", ...vapid });
    expect(value.webPush).toEqual({
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey,
      subject: "mailto:operator@example.test",
    });
  });

  it("refuses a half-configured keypair rather than offering a dead switch", () => {
    for (const missing of ["PRIME_WEB_VAPID_PUBLIC_KEY", "PRIME_WEB_VAPID_PRIVATE_KEY"]) {
      const partial = { ...vapid, [missing]: undefined };
      expect(() => loadConfig({ NODE_ENV: "test", ...partial })).toThrow("must be set together");
    }
  });

  // The subject is the one part of this worth setting by hand when the keys are
  // generated, so requiring the keys alongside it made the useful case illegal.
  it("takes a subject on its own, and defaults it when absent", () => {
    const named = loadConfig({ NODE_ENV: "test", PRIME_WEB_VAPID_SUBJECT: "mailto:operator@example.test" });
    expect(named.webPush).toBeUndefined();
    expect(named.generatedWebPush).toBe(true);
    expect(named.webPushSubject).toBe("mailto:operator@example.test");

    const bare = loadConfig({ NODE_ENV: "test" });
    expect(bare.generatedWebPush).toBe(true);
    expect(bare.webPushSubject).toBe(DEFAULT_VAPID_SUBJECT);

    // Explicit keys still win, and are not reported as generated.
    const explicit = loadConfig({ NODE_ENV: "test", ...vapid });
    expect(explicit.generatedWebPush).toBe(false);
    expect(explicit.webPush?.publicKey).toBe(vapidPublicKey);
  });

  it("keeps the minted keypair beside the other gateway state", () => {
    expect(loadConfig({ NODE_ENV: "test", XDG_CONFIG_HOME: "/srv/config" }).vapidKeysPath)
      .toBe("/srv/config/prime-agent-web/vapid-keys.json");
  });

  it("rejects a truncated or non-base64url VAPID key and a bare subject", () => {
    expect(() => loadConfig({ NODE_ENV: "test", ...vapid, PRIME_WEB_VAPID_PUBLIC_KEY: vapidPrivateKey }))
      .toThrow("must decode to 65 bytes");
    expect(() => loadConfig({ NODE_ENV: "test", ...vapid, PRIME_WEB_VAPID_PRIVATE_KEY: vapidPublicKey }))
      .toThrow("must decode to 32 bytes");
    expect(() => loadConfig({ NODE_ENV: "test", ...vapid, PRIME_WEB_VAPID_PRIVATE_KEY: "not+base64url/at=all" }))
      .toThrow("must be base64url");
    expect(() => loadConfig({ NODE_ENV: "test", ...vapid, PRIME_WEB_VAPID_SUBJECT: "operator@example.test" }))
      .toThrow("mailto: or https:// URL");
  });

  it("defaults the subscription store under the config directory and demands an absolute override", () => {
    expect(loadConfig({ NODE_ENV: "test", XDG_CONFIG_HOME: "/srv/config" }).webPushStorePath)
      .toBe("/srv/config/prime-agent-web/push-subscriptions.json");
    expect(loadConfig({ NODE_ENV: "test", XDG_CONFIG_HOME: undefined }).webPushStorePath)
      .toBe(path.join(homedir(), ".config", "prime-agent-web", "push-subscriptions.json"));
    expect(loadConfig({ NODE_ENV: "test", PRIME_WEB_PUSH_STORE: "/var/lib/prime/push.json" }).webPushStorePath)
      .toBe("/var/lib/prime/push.json");
    expect(() => loadConfig({ NODE_ENV: "test", PRIME_WEB_PUSH_STORE: "push.json" }))
      .toThrow("must be an absolute path");
  });
});
