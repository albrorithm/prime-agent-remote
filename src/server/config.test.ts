import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("requires an explicit origin allowlist in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("PRIME_WEB_ALLOWED_ORIGINS");
  });

  it("accepts canonical HTTP origins and validated ports", () => {
    const value = loadConfig({
      NODE_ENV: "production",
      PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test",
      PRIME_WEB_PORT: "9443",
    });
    expect(value.allowedOrigins).toEqual(new Set(["https://agent.example.test"]));
    expect(value.port).toBe(9443);
    expect(value.secureCookie).toBe(true);
  });

  it("rejects paths, unsupported schemes, and invalid ports", () => {
    expect(() => loadConfig({ PRIME_WEB_ALLOWED_ORIGINS: "https://agent.example.test/path" })).toThrow("Invalid allowed origin");
    expect(() => loadConfig({ PRIME_WEB_ALLOWED_ORIGINS: "file:///tmp/app" })).toThrow("Invalid allowed origin");
    expect(() => loadConfig({ PRIME_WEB_PORT: "70000" })).toThrow("PRIME_WEB_PORT");
  });
});
