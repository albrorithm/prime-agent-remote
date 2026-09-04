import { describe, expect, it } from "vitest";
import { CONFIG_FILE_VARIABLES } from "../server/config.js";
import { demoConfigDir, demoEnv } from "./demo-stores.js";

describe("demoConfigDir", () => {
  it("lives beside, not inside, the real config directory", () => {
    const dir = demoConfigDir({ HOME: "/home/alan" });
    expect(dir).not.toMatch(/prime-agent-web$/u);
    expect(dir.endsWith("prime-agent-web-demo")).toBe(true);
  });

  it("respects XDG_CONFIG_HOME like the server's own config resolution does", () => {
    const dir = demoConfigDir({ XDG_CONFIG_HOME: "/custom/config" });
    expect(dir).toBe("/custom/config/prime-agent-web-demo");
  });
});

describe("demoEnv", () => {
  it("redirects every persistent store away from its real default", () => {
    const env = demoEnv({ XDG_CONFIG_HOME: "/custom/config" });
    expect(env.PRIME_WEB_PAIRING_TOKEN_FILE).toBe("/custom/config/prime-agent-web-demo/pairing-token");
    expect(env.PRIME_WEB_DEVICE_STORE).toBe("/custom/config/prime-agent-web-demo/devices.json");
    expect(env.PRIME_WEB_STATE_FILE).toBe("/custom/config/prime-agent-web-demo/gateway.json");
    expect(env.PRIME_WEB_PUSH_STORE).toBe("/custom/config/prime-agent-web-demo/push-subscriptions.json");
    expect(env.PRIME_WEB_VAPID_KEY_FILE).toBe("/custom/config/prime-agent-web-demo/vapid-keys.json");
    // The list the server keeps, not a copy of it: a store added there must
    // be redirected here or the demo writes it into the real directory.
    for (const variable of Object.values(CONFIG_FILE_VARIABLES)) {
      expect(env[variable]).toMatch(/^\/custom\/config\/prime-agent-web-demo\//u);
    }
  });

  it("preserves every other variable so it is safe to spawn a child with", () => {
    const env = demoEnv({ PATH: "/usr/bin", NODE_ENV: "production" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_ENV).toBe("production");
  });
});
