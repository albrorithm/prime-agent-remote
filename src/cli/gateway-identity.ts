/**
 * Whether an HTTP response came from this gateway, not just from something
 * that answers on the port.
 *
 * `waitForListening` used to accept any TCP connect as "it's up," so a
 * leftover process — someone else's server, or this gateway's own dying
 * predecessor mid-restart — was greeted as success: the CLI printed "Running
 * at …" with the real setup token while `status` immediately said "not
 * running." There is no dedicated health endpoint, and this module does not
 * add one (that would mean editing src/server/**, owned elsewhere here). It
 * reuses a shape the gateway already produces for free: an unauthenticated
 * `GET /api/v1/bootstrap` always 401s with this exact RFC 7807-ish body
 * (`src/server/gateway.ts`'s `problem()`), which an arbitrary process on the
 * port is very unlikely to reproduce byte-for-byte.
 */
export function isPrimeWebGatewayResponse(status: number, contentType: string | null, body: unknown): boolean {
  if (status !== 401) return false;
  if (!contentType?.includes("application/json")) return false;
  if (body == null || typeof body !== "object") return false;
  const problem = body as Record<string, unknown>;
  return problem.type === "about:blank" && problem.title === "Authentication required" && problem.status === 401;
}
