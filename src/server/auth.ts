import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

const SESSION_COOKIE = "prime_web_session";
export const PAIR_ATTEMPT_WINDOW_MS = 60_000;
export const MAX_PAIR_ATTEMPTS_PER_CLIENT = 5;
export const MAX_TRACKED_PAIR_CLIENTS = 4_096;
export const MAX_ACTIVE_SESSIONS = 4_096;

interface Session {
  id: string;
  csrfToken: string;
  expiresAt: number;
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
  private lastSessionPruneAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly config: GatewayConfig) {}

  isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && this.config.allowedOrigins.has(origin);
  }

  pair(req: IncomingMessage, res: ServerResponse, token: string): Session | null {
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    this.pruneSessions(now, this.sessions.size >= MAX_ACTIVE_SESSIONS);

    // Recorded before the token check so failed guesses burn the budget too.
    if (!this.pairAttempts.allow(key, now).allowed) return null;
    if (!safeEqual(token, this.config.pairingToken)) return null;
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) return null;
    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    res.setHeader(
      "Set-Cookie",
      this.sessionCookie(encodeURIComponent(session.id), Math.max(1, Math.ceil(this.config.sessionTtlMs / 1000))),
    );
    return session;
  }

  signOut(res: ServerResponse, session: Session): void {
    this.sessions.delete(session.id);
    res.setHeader("Set-Cookie", this.sessionCookie("", 0));
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

  // Shared so the clearing cookie cannot drift from the one pair() set: a
  // browser keeps the original cookie if any attribute differs.
  private sessionCookie(value: string, maxAgeSeconds: number): string {
    const secure = this.config.secureCookie ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
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
