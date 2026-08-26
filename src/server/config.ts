import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * VAPID identifies this gateway to the push services it hands encrypted
 * payloads to. Absent keys are not an error — push is simply off, and the
 * gateway runs exactly as it did before it could push at all.
 */
export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface GatewayConfig {
  host: string;
  port: number;
  allowedOrigins: Set<string>;
  pairingToken: string;
  generatedPairingToken: boolean;
  secureCookie: boolean;
  backend: "demo" | "prime";
  /**
   * Only an explicit operator override. Undefined means "discover it", which
   * is the normal case: Prime Agent is usually a global install that a bare
   * specifier from this package cannot see.
   */
  primeModule?: string;
  daemonSocket?: string;
  sessionTtlMs: number;
  webPush?: WebPushConfig;
  webPushStorePath: string;
  /** Where an unconfigured gateway keeps the token it minted for itself. */
  pairingTokenPath: string;
  deviceStorePath: string;
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

/**
 * A VAPID key is a raw P-256 point (65 bytes) or scalar (32 bytes) in
 * base64url. Checking the decoded length here turns a truncated paste into a
 * startup error instead of a push that silently fails on every send.
 */
function parseVapidKey(name: string, value: string, expectedBytes: number): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${name} must be base64url`);
  if (Buffer.from(value, "base64url").byteLength !== expectedBytes) {
    throw new Error(`${name} must decode to ${expectedBytes} bytes`);
  }
  return value;
}

function parseWebPush(env: NodeJS.ProcessEnv): WebPushConfig | undefined {
  const publicKey = env.PRIME_WEB_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.PRIME_WEB_VAPID_PRIVATE_KEY?.trim();
  const subject = env.PRIME_WEB_VAPID_SUBJECT?.trim();
  if (!publicKey && !privateKey && !subject) return undefined;
  // All three or none. A half-configured keypair would leave the Settings
  // panel offering a control that cannot work, which is the one outcome the
  // "push is off" path exists to avoid.
  if (!publicKey || !privateKey || !subject) {
    throw new Error("PRIME_WEB_VAPID_PUBLIC_KEY, PRIME_WEB_VAPID_PRIVATE_KEY, and PRIME_WEB_VAPID_SUBJECT must be set together");
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("PRIME_WEB_VAPID_SUBJECT must be a mailto: or https:// URL");
  }
  return {
    publicKey: parseVapidKey("PRIME_WEB_VAPID_PUBLIC_KEY", publicKey, 65),
    privateKey: parseVapidKey("PRIME_WEB_VAPID_PRIVATE_KEY", privateKey, 32),
    subject,
  };
}

/**
 * The gateway's only persistent state. A push subscription has to outlive the
 * session that authorized it — that is the entire point of push — so it cannot
 * live beside the in-memory sessions.
 */
function configFilePath(env: NodeJS.ProcessEnv, variable: string, filename: string): string {
  const configured = env[variable]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`${variable} must be an absolute path`);
    return configured;
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(configHome, "prime-agent-web", filename);
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
  // Production no longer demands the variable. An unset token is now minted at
  // 32 random bytes and persisted at mode 0600, which is stronger than a
  // human-chosen one and keeps a long-lived secret out of the process
  // environment, where any `ps` can read it. What production still refuses is
  // a *weak* token, checked below.
  if (configuredPairingToken && configuredPairingToken.length > MAX_PAIRING_TOKEN_CHARS) {
    throw new Error(`PRIME_WEB_PAIRING_TOKEN must be at most ${MAX_PAIRING_TOKEN_CHARS} characters`);
  }
  if (production && configuredPairingToken && configuredPairingToken.length < MIN_PRODUCTION_PAIRING_TOKEN_CHARS) {
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
    primeModule: env.PRIME_AGENT_MODULE?.trim() || undefined,
    daemonSocket: env.PRIME_AGENT_DAEMON_SOCKET?.trim() || undefined,
    sessionTtlMs: parseInteger("PRIME_WEB_SESSION_TTL_MS", env.PRIME_WEB_SESSION_TTL_MS, 12 * 60 * 60 * 1000, 100, 7 * 24 * 60 * 60 * 1000),
    webPush: parseWebPush(env),
    webPushStorePath: configFilePath(env, "PRIME_WEB_PUSH_STORE", "push-subscriptions.json"),
    pairingTokenPath: configFilePath(env, "PRIME_WEB_PAIRING_TOKEN_FILE", "pairing-token"),
    deviceStorePath: configFilePath(env, "PRIME_WEB_DEVICE_STORE", "devices.json"),
  };
}
