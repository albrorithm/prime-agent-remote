import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

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
    for (const missing of Object.keys(vapid)) {
      const partial = { ...vapid, [missing]: undefined };
      expect(() => loadConfig({ NODE_ENV: "test", ...partial })).toThrow("must be set together");
    }
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
