import { pairingGrantSchema, type PairingGrant } from "../protocol.js";

export class PairingGrantError extends Error {}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Asks a running gateway for a one-time pairing link, presenting the setup
 * token as a bearer. Only a running gateway can mint one: a grant lives in
 * the gateway's memory, which is where a link is spent.
 */
export async function mintPairingGrant(origin: string, setupToken: string, fetchImpl: FetchLike = fetch): Promise<PairingGrant> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/auth/grants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${setupToken}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new PairingGrantError("Could not reach the gateway to mint a pairing link.");
  }
  if (response.status === 401) {
    throw new PairingGrantError("The gateway did not accept this setup token. It may have been started with a different one; restart it.");
  }
  if (!response.ok) throw new PairingGrantError(`The gateway refused to mint a pairing link (${response.status}).`);
  const parsed = pairingGrantSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new PairingGrantError("The gateway answered with something that is not a pairing link.");
  return parsed.data;
}

/** Voids every outstanding pairing link the gateway holds. Returns how many went. */
export async function revokePairingGrants(origin: string, setupToken: string, fetchImpl: FetchLike = fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/auth/grants/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${setupToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new PairingGrantError("Could not reach the gateway to void its pairing links.");
  }
  if (!response.ok) throw new PairingGrantError(`The gateway refused to void its pairing links (${response.status}).`);
  const body = await response.json().catch(() => null) as { revoked?: unknown } | null;
  return typeof body?.revoked === "number" ? body.revoked : 0;
}

/** "10:42" in the local clock, which is how a person reads a deadline off a terminal. */
export function expiryClock(expiresAt: string, now = new Date()): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "ten minutes from now";
  const minutes = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return minutes <= 0 ? `${clock} (now)` : `${clock} (${minutes} min)`;
}
