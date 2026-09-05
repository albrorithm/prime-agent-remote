import { describe, expect, it } from "vitest";
import { MAX_LIVE_PAIRING_GRANTS, PAIRING_GRANT_TTL_MS, PairingGrants } from "./pairing-grants.js";

describe("PairingGrants", () => {
  it("spends a grant exactly once", () => {
    const grants = new PairingGrants();
    const { token } = grants.mint(1_000);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(grants.redeem(token, 2_000)).toBe("ok");
    expect(grants.redeem(token, 2_000)).toBe("unknown");
  });

  it("tells a lapsed grant apart from one that never existed, and spends it too", () => {
    const grants = new PairingGrants();
    const { token, expiresAt } = grants.mint(1_000);
    expect(expiresAt).toBe(1_000 + PAIRING_GRANT_TTL_MS);
    expect(grants.redeem(token, expiresAt)).toBe("expired");
    expect(grants.redeem(token, expiresAt)).toBe("unknown");
    expect(grants.redeem("never-minted", 1_000)).toBe("unknown");
  });

  it("revokes one grant or all of them at once", () => {
    const grants = new PairingGrants();
    const first = grants.mint(1_000).token;
    const second = grants.mint(1_000).token;
    expect(grants.revoke(first)).toBe(1);
    expect(grants.redeem(first, 1_000)).toBe("unknown");
    expect(grants.redeem(second, 1_000)).toBe("ok");
    grants.mint(1_000);
    grants.mint(1_000);
    expect(grants.revoke()).toBe(2);
    expect(grants.size).toBe(0);
  });

  it("holds a bounded number and lets the oldest go first", () => {
    const grants = new PairingGrants();
    const oldest = grants.mint(1_000).token;
    for (let index = 0; index < MAX_LIVE_PAIRING_GRANTS; index += 1) grants.mint(1_000 + index);
    expect(grants.size).toBe(MAX_LIVE_PAIRING_GRANTS);
    expect(grants.redeem(oldest, 2_000)).toBe("unknown");
  });

  it("does not let lapsed grants count against the bound", () => {
    const grants = new PairingGrants();
    const stale = grants.mint(0).token;
    const fresh = grants.mint(PAIRING_GRANT_TTL_MS + 1).token;
    expect(grants.size).toBe(1);
    expect(grants.redeem(stale, PAIRING_GRANT_TTL_MS + 1)).toBe("unknown");
    expect(grants.redeem(fresh, PAIRING_GRANT_TTL_MS + 1)).toBe("ok");
  });
});
