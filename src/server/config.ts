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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function loadConfig(env = process.env): GatewayConfig {
  const production = env.NODE_ENV === "production";
  const configuredPairingToken = env.PRIME_WEB_PAIRING_TOKEN?.trim();
  const configuredOrigins = env.PRIME_WEB_ALLOWED_ORIGINS?.trim();
  if (production && !configuredOrigins) {
    throw new Error("PRIME_WEB_ALLOWED_ORIGINS is required in production");
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
  const port = Number.parseInt(env.PRIME_WEB_PORT || "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PRIME_WEB_PORT must be between 1 and 65535");
  return {
    host: env.PRIME_WEB_HOST?.trim() || "127.0.0.1",
    port,
    allowedOrigins,
    pairingToken: configuredPairingToken || randomBytes(24).toString("base64url"),
    generatedPairingToken: !configuredPairingToken,
    secureCookie: parseBoolean(env.PRIME_WEB_SECURE_COOKIE, production),
    backend: env.PRIME_WEB_BACKEND === "prime" ? "prime" : "demo",
    primeModule: env.PRIME_AGENT_MODULE?.trim() || "@earendil-works/pi-coding-agent",
    daemonSocket: env.PRIME_AGENT_DAEMON_SOCKET?.trim() || undefined,
    sessionTtlMs: 12 * 60 * 60 * 1000,
  };
}
