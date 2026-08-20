import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.js";

const SESSION_COOKIE = "prime_web_session";

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

  constructor(private readonly config: GatewayConfig) {}

  isAllowedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && this.config.allowedOrigins.has(origin);
  }

  pair(req: IncomingMessage, res: ServerResponse, token: string): Session | null {
    this.prune();
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (this.pairAttempts.get(key) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 5) return null;
    recent.push(now);
    this.pairAttempts.set(key, recent);
    if (!safeEqual(token, this.config.pairingToken)) return null;

    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    const secure = this.config.secureCookie ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}${secure}`,
    );
    return session;
  }

  authenticate(req: IncomingMessage): Session | null {
    this.prune();
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return null;
    return this.sessions.get(id) ?? null;
  }

  validateMutation(req: IncomingMessage, session: Session): boolean {
    const csrf = req.headers["x-csrf-token"];
    return this.isAllowedOrigin(req) && typeof csrf === "string" && safeEqual(csrf, session.csrfToken);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

export type AuthenticatedSession = NonNullable<ReturnType<AuthService["authenticate"]>>;
