import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.js";
import type { DeviceStore } from "./device-store.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

const SESSION_COOKIE = "prime_web_session";
const DEVICE_COOKIE = "prime_web_device";
/**
 * Browsers cap persistent cookies at 400 days, so asking for more only looks
 * like it worked. A device that goes unused for longer re-pairs.
 */
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export const PAIR_ATTEMPT_WINDOW_MS = 60_000;
export const MAX_PAIR_ATTEMPTS_PER_CLIENT = 5;
export const MAX_TRACKED_PAIR_CLIENTS = 4_096;
export const MAX_ACTIVE_SESSIONS = 4_096;
/**
 * Resumes are budgeted per proven device rather than per address.
 *
 * Behind `tailscale serve` every client arrives as 127.0.0.1, so the address
 * bucket is not one bucket per caller — it is one bucket for the whole house.
 * Five phones auto-resuming in the minute after a restart, which is precisely
 * what a restart causes, would spend it and 401 people who had paired
 * perfectly correctly. A device id is the only caller identity that survives
 * that hop, and it is only trusted once the credential has been verified.
 */
export const RESUME_ATTEMPT_WINDOW_MS = 60_000;
export const MAX_RESUME_ATTEMPTS_PER_DEVICE = 30;
export const MAX_TRACKED_RESUME_DEVICES = 4_096;

interface Session {
  id: string;
  csrfToken: string;
  expiresAt: number;
  /** Set when this session was started by a paired device credential. */
  deviceId?: string;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookie pairs rather than failing the whole request.
    }
  }
  return cookies;
}

export class AuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly pairAttempts = new SlidingWindowLimiter(
    PAIR_ATTEMPT_WINDOW_MS,
    MAX_PAIR_ATTEMPTS_PER_CLIENT,
    MAX_TRACKED_PAIR_CLIENTS,
  );
  private readonly resumeAttempts = new SlidingWindowLimiter(
    RESUME_ATTEMPT_WINDOW_MS,
    MAX_RESUME_ATTEMPTS_PER_DEVICE,
    MAX_TRACKED_RESUME_DEVICES,
  );
  private lastSessionPruneAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: GatewayConfig,
    /**
     * Absent in demo and in tests that predate device pairing: without it the
     * gateway behaves exactly as it did before, pairing token every time.
     */
    private readonly devices?: DeviceStore,
  ) {}

  isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && this.config.allowedOrigins.has(origin);
  }

  async pair(req: IncomingMessage, res: ServerResponse, token: string, deviceName?: string): Promise<Session | null> {
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    this.pruneSessions(now, this.sessions.size >= MAX_ACTIVE_SESSIONS);

    // Recorded before the token check so failed guesses burn the budget too.
    if (!this.pairAttempts.allow(key, now).allowed) return null;
    if (!safeEqual(token, this.config.pairingToken)) return null;
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) return null;

    // Issued before the session so a store that cannot be written fails the
    // pairing outright, rather than handing back a session whose device cookie
    // silently will not work on the next restart.
    const issued = this.devices ? await this.devices.issue(deviceName?.trim() || "device") : null;
    const session = this.startSession(now, issued?.device.id);
    const cookies = [this.sessionCookieHeader(session)];
    if (issued) cookies.push(this.deviceCookieHeader(issued.token, DEVICE_COOKIE_MAX_AGE_SECONDS));
    res.setHeader("Set-Cookie", cookies);
    return session;
  }

  /**
   * Starts a session from a device credential the browser already holds.
   *
   * This is what makes a gateway restart survivable. Sessions are in memory
   * and die with the process; without this every restart would send every
   * phone in the house back to the pairing token.
   */
  async resume(req: IncomingMessage, res: ServerResponse): Promise<Session | null> {
    if (!this.devices) return null;
    const address = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    this.pruneSessions(now, this.sessions.size >= MAX_ACTIVE_SESSIONS);
    const presented = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    const device = presented ? await this.devices.verify(presented) : null;
    if (!device) {
      // An unproven attempt is a guess, and guesses are what the address budget
      // exists for — a burnt budget locks this address out of `pair` too, so
      // guessing device tokens still costs what guessing the pairing token
      // costs. Charged only *after* verification fails: keying a limiter on an
      // id nobody has verified would let an attacker mint a fresh id per guess
      // and buy an unlimited number of empty buckets.
      this.pairAttempts.allow(address, now);
      // The credential was revoked or the store was rebuilt. Clear it so the
      // browser stops presenting something that can never work again.
      if (presented) res.setHeader("Set-Cookie", this.deviceCookieHeader("", 0));
      return null;
    }
    // A proven device gets its own budget, so a houseful of phones reconnecting
    // through one tailscale address no longer share a single bucket.
    if (!this.resumeAttempts.allow(device.id, now).allowed) return null;
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) return null;
    const session = this.startSession(now, device.id);
    res.setHeader("Set-Cookie", this.sessionCookieHeader(session));
    return session;
  }

  private startSession(now: number, deviceId?: string): Session {
    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: now + this.config.sessionTtlMs,
      deviceId,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Signing out is deliberately stronger than letting a session expire: it
   * revokes the device credential too, so the browser cannot quietly resume.
   * Expiry keeps the device, which is what lets a phone survive a restart.
   */
  async signOut(res: ServerResponse, session: Session): Promise<string[]> {
    const reaped = this.sessionIdsForDevice(session);
    // Deleted before the await, so a request arriving during the revoke cannot
    // find one of these sessions still live.
    for (const id of reaped) this.sessions.delete(id);
    const cookies = [this.sessionCookieHeader(null)];
    if (session.deviceId && this.devices) {
      await this.devices.revoke(session.deviceId);
      cookies.push(this.deviceCookieHeader("", 0));
    }
    res.setHeader("Set-Cookie", cookies);
    return reaped;
  }

  /**
   * Every session a sign-out of this one takes with it.
   *
   * Revoking the device credential while leaving that device's other sessions
   * running made sign-out a promise the gateway did not keep: a second tab, or
   * the same phone reopened, kept a working session — and its live socket — for
   * the rest of the 12-hour TTL, long after the person had signed out. Those
   * sessions all descend from the credential being revoked, so revoking it has
   * to take them too.
   *
   * A session with no device id is its own only member: nothing links it to
   * any other, and reaping by absence would sign out every token-paired
   * session at once.
   */
  sessionIdsForDevice(session: Session): string[] {
    const ids = [session.id];
    if (!session.deviceId) return ids;
    for (const [id, other] of this.sessions) {
      if (id !== session.id && other.deviceId === session.deviceId) ids.push(id);
    }
    return ids;
  }

  authenticate(req: IncomingMessage): Session | null {
    const now = Date.now();
    this.pruneSessions(now);
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(id);
      return null;
    }
    return session;
  }

  isSessionActive(session: Session): boolean {
    const active = this.sessions.get(session.id);
    if (active !== session) return false;
    if (session.expiresAt > Date.now()) return true;
    this.sessions.delete(session.id);
    return false;
  }

  validateMutation(req: IncomingMessage, session: Session): boolean {
    const csrf = req.headers["x-csrf-token"];
    return this.isSessionActive(session)
      && this.isAllowedOrigin(req)
      && typeof csrf === "string"
      && safeEqual(csrf, session.csrfToken);
  }

  // Shared so a clearing cookie cannot drift from the one that was set: a
  // browser keeps the original cookie if any attribute differs.
  private cookie(name: string, value: string, maxAgeSeconds: number): string {
    const secure = this.config.secureCookie ? "; Secure" : "";
    return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
  }

  private sessionCookieHeader(session: Session | null): string {
    return session
      ? this.cookie(SESSION_COOKIE, encodeURIComponent(session.id), Math.max(1, Math.ceil(this.config.sessionTtlMs / 1000)))
      : this.cookie(SESSION_COOKIE, "", 0);
  }

  private deviceCookieHeader(token: string, maxAgeSeconds: number): string {
    return this.cookie(DEVICE_COOKIE, encodeURIComponent(token), maxAgeSeconds);
  }

  private pruneSessions(now: number, force = false): void {
    if (!force && now - this.lastSessionPruneAt < PAIR_ATTEMPT_WINDOW_MS) return;
    this.lastSessionPruneAt = now;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

export type AuthenticatedSession = NonNullable<ReturnType<AuthService["authenticate"]>>;
