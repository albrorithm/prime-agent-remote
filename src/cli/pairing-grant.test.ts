import { describe, expect, it } from "vitest";
import { expiryClock, mintPairingGrant, PairingGrantError, revokePairingGrants } from "./pairing-grant.js";

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("mintPairingGrant", () => {
  it("presents the setup token as a bearer and reads the grant back", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const grant = await mintPairingGrant("http://127.0.0.1:4318", "setup-secret", async (url, init) => {
      calls.push({ url, init });
      return answer(201, { token: "g".repeat(43), expiresAt: "2026-01-01T00:10:00.000Z" });
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4318/api/v1/auth/grants");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer setup-secret");
    expect(grant.token).toBe("g".repeat(43));
  });

  it("names the three ways it can fail without leaking the token", async () => {
    await expect(mintPairingGrant("http://x", "s", async () => { throw new Error("ECONNREFUSED"); }))
      .rejects.toThrow(PairingGrantError);
    await expect(mintPairingGrant("http://x", "s", async () => answer(401, { title: "Invalid setup token" })))
      .rejects.toThrow(/did not accept this setup token/);
    await expect(mintPairingGrant("http://x", "s", async () => answer(201, { nope: true })))
      .rejects.toThrow(/not a pairing link/);
  });

  it("tells a throttled address to wait, not to restart the gateway", async () => {
    const throttled = () => new Response("{}", { status: 429, headers: { "Retry-After": "42" } });
    await expect(mintPairingGrant("http://x", "s", async () => throttled())).rejects.toThrow(/try again in 42 seconds/);
    await expect(mintPairingGrant("http://x", "s", async () => throttled())).rejects.not.toThrow(/restart/);
    await expect(revokePairingGrants("http://x", "s", async () => throttled())).rejects.toThrow(/try again in 42 seconds/);
  });
});

describe("revokePairingGrants", () => {
  it("reports how many links went", async () => {
    expect(await revokePairingGrants("http://x", "s", async () => answer(200, { revoked: 3 }))).toBe(3);
    await expect(revokePairingGrants("http://x", "s", async () => answer(401, {}))).rejects.toThrow(PairingGrantError);
  });
});

describe("expiryClock", () => {
  it("says the minutes left beside the clock time", () => {
    const now = new Date("2026-01-01T10:00:00");
    expect(expiryClock("2026-01-01T10:10:00", now)).toMatch(/\(10 min\)$/);
    expect(expiryClock("2026-01-01T09:00:00", now)).toMatch(/\(now\)$/);
    expect(expiryClock("not a date", now)).toBe("ten minutes from now");
  });
});
