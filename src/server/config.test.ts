import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const strongToken = "a-random-production-pairing-token-0001";

describe("loadConfig", () => {
  it("requires an explicit origin allowlist and strong configured token in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("PRIME_WEB_ALLOWED_ORIGINS");
    expect(() => loadConfig({
      NODE_ENV: "production",
      PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test",
    })).toThrow("PRIME_WEB_PAIRING_TOKEN");
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
});
