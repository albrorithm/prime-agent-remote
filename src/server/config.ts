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
  /**
   * True when no keys were supplied and `index.ts` should mint them from
   * `vapidKeysPath`. Mirrors `generatedPairingToken`: `loadConfig` stays free of
   * file I/O so the suite cannot write to an operator's configuration.
   */
  generatedWebPush: boolean;
  /** The subject to stamp on keys the gateway mints for itself. */
  webPushSubject: string;
  /** Where an unconfigured gateway keeps the VAPID keypair it minted. */
  vapidKeysPath: string;
  webPushStorePath: string;
  /** Where an unconfigured gateway keeps the token it minted for itself. */
  pairingTokenPath: string;
  deviceStorePath: string;
  /** Where the launcher records a running gateway so other tools can find it. */
  gatewayStatePath: string;
}

/**
 * A push service uses the VAPID subject only to reach whoever is sending, if
 * something is wrong with the sending. This gateway is somebody's laptop, so
 * there is no address worth putting here and certainly not the operator's: the
 * project URL identifies the software, which is the useful half.
 * `PRIME_WEB_VAPID_SUBJECT` overrides it.
 */
export const DEFAULT_VAPID_SUBJECT = "https://github.com/albrorithm/prime-agent-mobile";

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

function parseVapidSubject(env: NodeJS.ProcessEnv): string | undefined {
  const subject = env.PRIME_WEB_VAPID_SUBJECT?.trim();
  if (!subject) return undefined;
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("PRIME_WEB_VAPID_SUBJECT must be a mailto: or https:// URL");
  }
  return subject;
}

/**
 * Explicit keys, or undefined to mean "the gateway mints its own" — which is
 * now the normal case, resolved in `index.ts` where the file I/O lives.
 *
 * A subject on its own is deliberately not an error. It is the one part of this
 * worth setting by hand when the keys are generated, and rejecting it would
 * make the useful case the illegal one.
 */
function parseWebPush(env: NodeJS.ProcessEnv): WebPushConfig | undefined {
  const publicKey = env.PRIME_WEB_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.PRIME_WEB_VAPID_PRIVATE_KEY?.trim();
  const subject = parseVapidSubject(env);
  if (!publicKey && !privateKey) return undefined;
  // Both keys or neither. A half-configured keypair would leave the Settings
  // panel offering a control that cannot work, which is the one outcome the
  // "push is off" path exists to avoid.
  if (!publicKey || !privateKey) {
    throw new Error("PRIME_WEB_VAPID_PUBLIC_KEY and PRIME_WEB_VAPID_PRIVATE_KEY must be set together");
  }
  return {
    publicKey: parseVapidKey("PRIME_WEB_VAPID_PUBLIC_KEY", publicKey, 65),
    privateKey: parseVapidKey("PRIME_WEB_VAPID_PRIVATE_KEY", privateKey, 32),
    subject: subject ?? DEFAULT_VAPID_SUBJECT,
  };
}

/**
 * Every store the gateway writes, as `GatewayConfig` field → env override.
 *
 * This exists so a test that must keep a spawned gateway off the operator's
 * real files can enumerate them instead of remembering them. A comment asking
 * the next person to update a hand-written list was already there, and the next
 * person added `vapid-keys.json` and walked straight past it — paying a
 * generated keypair into `~/.config/prime-agent-web` on every `npm test`. A list
 * that has to be kept in step by hand will not be.
 */
export const CONFIG_FILE_VARIABLES = {
  webPushStorePath: "PRIME_WEB_PUSH_STORE",
  vapidKeysPath: "PRIME_WEB_VAPID_KEY_FILE",
  pairingTokenPath: "PRIME_WEB_PAIRING_TOKEN_FILE",
  gatewayStatePath: "PRIME_WEB_STATE_FILE",
  deviceStorePath: "PRIME_WEB_DEVICE_STORE",
} as const satisfies Record<string, string>;

/**
 * The gateway's persistent state, all of it under one directory. These outlive
 * the process on purpose: a push subscription has to survive the session that
 * authorized it — that is the whole point of push — and a device credential has
 * to survive a restart or every phone re-pairs.
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

/**
 * The origins a gateway started with no explicit allowlist will accept: the Vite
 * dev server, and the gateway's own address.
 *
 * The gateway's own port used to be hardcoded at 8787, so following
 * docs/deployment.md with `PRIME_WEB_PORT=8899` and no explicit origins built a
 * gateway that could not be paired with at all — the browser sends an Origin on
 * the port it was actually reached at, and that origin was on no list. The CLI
 * never hit this because it computes origins from the exposure it just set up,
 * which is what made the documented raw-node path a trap.
 *
 * This is not a widening: every origin here is one this process is listening on
 * or is developed against, and production still refuses to start without
 * PRIME_WEB_ALLOWED_ORIGINS set explicitly.
 */
function defaultAllowedOrigins(host: string, port: number): string[] {
  const origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:" + port,
    "http://127.0.0.1:" + port,
  ];
  // A wildcard bind is not an origin any browser can send, so adding one would
  // be noise. A real hostname is the address this gateway is reached at.
  const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const own = `http://${authority}:${port}`;
  if (!wildcard && !origins.includes(own)) origins.push(own);
  return origins;
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

  // Resolved before the allowlist, which needs the port the gateway will
  // actually bind.
  const host = env.PRIME_WEB_HOST?.trim() || "127.0.0.1";
  const port = parseInteger("PRIME_WEB_PORT", env.PRIME_WEB_PORT, 8787, 1, 65_535);

  const allowedOrigins = new Set(
    (configuredOrigins || defaultAllowedOrigins(host, port).join(","))
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

  const configuredWebPush = parseWebPush(env);

  return {
    host,
    port,
    allowedOrigins,
    pairingToken: configuredPairingToken || randomBytes(24).toString("base64url"),
    generatedPairingToken: !configuredPairingToken,
    secureCookie: parseBoolean("PRIME_WEB_SECURE_COOKIE", env.PRIME_WEB_SECURE_COOKIE, production),
    backend: parseBackend(env.PRIME_WEB_BACKEND),
    primeModule: env.PRIME_AGENT_MODULE?.trim() || undefined,
    daemonSocket: env.PRIME_AGENT_DAEMON_SOCKET?.trim() || undefined,
    sessionTtlMs: parseInteger("PRIME_WEB_SESSION_TTL_MS", env.PRIME_WEB_SESSION_TTL_MS, 12 * 60 * 60 * 1000, 100, 7 * 24 * 60 * 60 * 1000),
    webPush: configuredWebPush,
    generatedWebPush: !configuredWebPush,
    webPushSubject: parseVapidSubject(env) ?? DEFAULT_VAPID_SUBJECT,
    vapidKeysPath: configFilePath(env, CONFIG_FILE_VARIABLES.vapidKeysPath, "vapid-keys.json"),
    webPushStorePath: configFilePath(env, CONFIG_FILE_VARIABLES.webPushStorePath, "push-subscriptions.json"),
    pairingTokenPath: configFilePath(env, CONFIG_FILE_VARIABLES.pairingTokenPath, "pairing-token"),
    gatewayStatePath: configFilePath(env, CONFIG_FILE_VARIABLES.gatewayStatePath, "gateway.json"),
    deviceStorePath: configFilePath(env, CONFIG_FILE_VARIABLES.deviceStorePath, "devices.json"),
  };
}
