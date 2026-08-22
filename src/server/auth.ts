import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.js";

const SESSION_COOKIE = "prime_web_session";
const PAIR_ATTEMPT_WINDOW_MS = 60_000;
const MAX_PAIR_ATTEMPTS_PER_CLIENT = 5;
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
  private readonly pairAttempts = new Map<string, number[]>();
  private lastFullPruneAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly config: GatewayConfig) {}

  isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && this.config.allowedOrigins.has(origin);
  }

  pair(req: IncomingMessage, res: ServerResponse, token: string): Session | null {
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    this.prune(now, this.pairAttempts.size >= MAX_TRACKED_PAIR_CLIENTS || this.sessions.size >= MAX_ACTIVE_SESSIONS);

    const recent = (this.pairAttempts.get(key) ?? []).filter((time) => now - time < PAIR_ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_PAIR_ATTEMPTS_PER_CLIENT) return null;
    if (!this.pairAttempts.has(key) && this.pairAttempts.size >= MAX_TRACKED_PAIR_CLIENTS) return null;
    recent.push(now);
    this.pairAttempts.set(key, recent);
    if (!safeEqual(token, this.config.pairingToken)) return null;

    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      this.prune(now, true);
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) return null;
    }
    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    const secure = this.config.secureCookie ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.ceil(this.config.sessionTtlMs / 1000))}${secure}`,
    );
    return session;
  }

  authenticate(req: IncomingMessage): Session | null {
    const now = Date.now();
    this.prune(now);
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

  private prune(now: number, force = false): void {
    if (!force && now - this.lastFullPruneAt < PAIR_ATTEMPT_WINDOW_MS) return;
    this.lastFullPruneAt = now;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [key, times] of this.pairAttempts) {
      const recent = times.filter((time) => now - time < PAIR_ATTEMPT_WINDOW_MS);
      if (recent.length === 0) this.pairAttempts.delete(key);
      else if (recent.length !== times.length) this.pairAttempts.set(key, recent);
    }
  }
}

export type AuthenticatedSession = NonNullable<ReturnType<AuthService["authenticate"]>>;
