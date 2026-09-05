import { createHash, randomBytes } from "node:crypto";

/** Long enough to walk a phone over and scan; short enough that a screenshot goes stale. */
export const PAIRING_GRANT_TTL_MS = 10 * 60 * 1_000;
/** Live grants a gateway holds at once; minting past this evicts the oldest. */
export const MAX_LIVE_PAIRING_GRANTS = 32;
const GRANT_BYTES = 32;

export type GrantRedemption = "ok" | "expired" | "unknown";

/**
 * One-time pairing grants: what a pairing link carries instead of the setup
 * token. A grant is minted by something that holds the setup token, is spent
 * the first time any client presents it, and lapses on its own if nobody
 * does. The setup token itself never leaves the machine in a link again, so
 * a screenshot of a code, or a link left in a browser's history, is worth ten
 * minutes at most and one pairing at most.
 *
 * Held in memory, hashed. Grants do not survive a gateway restart, and that
 * is the right outcome: whoever wanted one can ask for another.
 */
export class PairingGrants {
  private readonly live = new Map<string, number>();

  get size(): number {
    return this.live.size;
  }

  mint(now = Date.now()): { token: string; expiresAt: number } {
    this.evictExpired(now);
    while (this.live.size >= MAX_LIVE_PAIRING_GRANTS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
    const token = randomBytes(GRANT_BYTES).toString("base64url");
    const expiresAt = now + PAIRING_GRANT_TTL_MS;
    this.live.set(hash(token), expiresAt);
    return { token, expiresAt };
  }

  /**
   * Spends the grant. Consumed on the way in whatever the answer, so two
   * clients presenting the same link at once cannot both pair, and a lapsed
   * one is told it lapsed rather than that it never existed: that is the
   * difference between "ask for a new link" and "this link is wrong".
   */
  redeem(token: string, now = Date.now()): GrantRedemption {
    const key = hash(token);
    const expiresAt = this.live.get(key);
    if (expiresAt === undefined) return "unknown";
    this.live.delete(key);
    return expiresAt > now ? "ok" : "expired";
  }

  /** Voids one grant, or every outstanding one. Returns how many went. */
  revoke(token?: string): number {
    if (token !== undefined) return this.live.delete(hash(token)) ? 1 : 0;
    const count = this.live.size;
    this.live.clear();
    return count;
  }

  private evictExpired(now: number): void {
    for (const [key, expiresAt] of this.live) if (expiresAt <= now) this.live.delete(key);
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
