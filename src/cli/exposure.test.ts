import { describe, expect, it } from "vitest";
import { ExposureError, defaultExposureMode, resolveExposure } from "./exposure.js";

describe("resolveExposure: tailscale", () => {
  it("keeps the gateway on loopback and trusts the tailnet name over HTTPS", () => {
    const exposure = resolveExposure({ mode: "tailscale", port: 8787, tailscaleHost: "host.tailnet.ts.net" });
    expect(exposure.host).toBe("127.0.0.1");
    expect(exposure.origins).toEqual(["https://host.tailnet.ts.net"]);
    expect(exposure.secureCookie).toBe(true);
    expect(exposure.warnings).toEqual([]);
  });

  it("strips the trailing dot Tailscale reports", () => {
    const exposure = resolveExposure({ mode: "tailscale", port: 8787, tailscaleHost: "host.tailnet.ts.net." });
    expect(exposure.url).toBe("https://host.tailnet.ts.net");
  });

  it("refuses rather than guessing when Tailscale reports no name", () => {
    expect(() => resolveExposure({ mode: "tailscale", port: 8787 })).toThrow(ExposureError);
  });
});

describe("resolveExposure: loopback", () => {
  it("allows both spellings of loopback and says it is not reachable from a phone", () => {
    const exposure = resolveExposure({ mode: "loopback", port: 8787 });
    expect(exposure.host).toBe("127.0.0.1");
    expect(exposure.origins).toEqual(["http://127.0.0.1:8787", "http://localhost:8787"]);
    expect(exposure.secureCookie).toBe(false);
    expect(exposure.warnings.join(" ")).toContain("only from this machine");
  });
});

describe("resolveExposure: lan", () => {
  it("binds every interface and pins the origin to a name, not an address", () => {
    const exposure = resolveExposure({ mode: "lan", port: 8787, localHostname: "study.local" });
    expect(exposure.host).toBe("0.0.0.0");
    expect(exposure.origins).toEqual(["http://study.local:8787"]);
  });

  it("says plainly what plain HTTP costs", () => {
    const exposure = resolveExposure({ mode: "lan", port: 8787, localHostname: "study.local" });
    const warnings = exposure.warnings.join(" ");
    expect(warnings).toContain("experimental");
    expect(warnings).toContain("every device on this network");
    expect(warnings).toContain("not a secure context");
    expect(exposure.secureCookie).toBe(false);
  });

  it("warns that plain HTTP puts the token, session cookie, and device credential on the wire in the clear", () => {
    const warnings = resolveExposure({ mode: "lan", port: 8787, localHostname: "study.local" }).warnings.join(" ");
    // Distinct from "reachable by every device": reachability is what the
    // token defends against, this is the token (and what it issues) itself
    // being interceptable, which is a worse and longer-lived exposure.
    expect(warnings).toContain("setup token");
    expect(warnings).toContain("session cookie");
    expect(warnings).toContain("400-day device credential");
  });

  it("refuses without a resolvable hostname", () => {
    expect(() => resolveExposure({ mode: "lan", port: 8787 })).toThrow(ExposureError);
  });
});

describe("resolveExposure: port validation", () => {
  it("rejects a port outside the legal range", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => resolveExposure({ mode: "loopback", port })).toThrow(ExposureError);
    }
  });
});

describe("defaultExposureMode", () => {
  it("prefers Tailscale, the only phone-reachable secure context needing no certificate", () => {
    expect(defaultExposureMode({ tailscale: true })).toBe("tailscale");
  });

  it("falls back to loopback rather than silently exposing a network", () => {
    expect(defaultExposureMode({ tailscale: false })).toBe("loopback");
  });
});
