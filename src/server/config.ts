import { randomBytes } from "node:crypto";

export interface GatewayConfig {
  host: string;
  port: number;
  allowedOrigins: Set<string>;
  pairingToken: string;
  generatedPairingToken: boolean;
  secureCookie: boolean;
  backend: "demo" | "prime";
  primeModule: string;
  daemonSocket?: string;
  sessionTtlMs: number;
}

const MIN_PRODUCTION_PAIRING_TOKEN_CHARS = 32;
const MAX_PAIRING_TOKEN_CHARS = 512;

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function parseInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value == null) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBackend(value: string | undefined): GatewayConfig["backend"] {
  if (value == null || value === "demo") return "demo";
  if (value === "prime") return "prime";
  throw new Error("PRIME_WEB_BACKEND must be demo or prime");
}

export function loadConfig(env = process.env): GatewayConfig {
  const production = env.NODE_ENV === "production";
  const configuredPairingToken = env.PRIME_WEB_PAIRING_TOKEN?.trim();
  const configuredOrigins = env.PRIME_WEB_ALLOWED_ORIGINS?.trim();
  if (production && !configuredOrigins) {
    throw new Error("PRIME_WEB_ALLOWED_ORIGINS is required in production");
  }
  if (production && !configuredPairingToken) {
    throw new Error("PRIME_WEB_PAIRING_TOKEN is required in production");
  }
  if (configuredPairingToken && configuredPairingToken.length > MAX_PAIRING_TOKEN_CHARS) {
    throw new Error(`PRIME_WEB_PAIRING_TOKEN must be at most ${MAX_PAIRING_TOKEN_CHARS} characters`);
  }
  if (production && configuredPairingToken!.length < MIN_PRODUCTION_PAIRING_TOKEN_CHARS) {
    throw new Error(`PRIME_WEB_PAIRING_TOKEN must be at least ${MIN_PRODUCTION_PAIRING_TOKEN_CHARS} characters in production`);
  }

  const allowedOrigins = new Set(
    (configuredOrigins || "http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8787")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const url = new URL(value);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
          throw new Error(`Invalid allowed origin: ${value}`);
        }
        return value;
      }),
  );
  if (allowedOrigins.size === 0) throw new Error("PRIME_WEB_ALLOWED_ORIGINS must contain at least one origin");

  return {
    host: env.PRIME_WEB_HOST?.trim() || "127.0.0.1",
    port: parseInteger("PRIME_WEB_PORT", env.PRIME_WEB_PORT, 8787, 1, 65_535),
    allowedOrigins,
    pairingToken: configuredPairingToken || randomBytes(24).toString("base64url"),
    generatedPairingToken: !configuredPairingToken,
    secureCookie: parseBoolean("PRIME_WEB_SECURE_COOKIE", env.PRIME_WEB_SECURE_COOKIE, production),
    backend: parseBackend(env.PRIME_WEB_BACKEND),
    primeModule: env.PRIME_AGENT_MODULE?.trim() || "@earendil-works/pi-coding-agent",
    daemonSocket: env.PRIME_AGENT_DAEMON_SOCKET?.trim() || undefined,
    sessionTtlMs: parseInteger("PRIME_WEB_SESSION_TTL_MS", env.PRIME_WEB_SESSION_TTL_MS, 12 * 60 * 60 * 1000, 100, 7 * 24 * 60 * 60 * 1000),
  };
}
