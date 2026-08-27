import { homedir } from "node:os";
import path from "node:path";

/**
 * The four persistent paths `--demo` must never share with a real run:
 * pairing token, paired-device list, gateway state, and push subscriptions.
 * `src/server/config.ts` derives all four from the same `~/.config/prime-agent-web/`
 * regardless of backend, so without this, demo mode prints the operator's
 * REAL pairing token, and a device paired during a demo becomes a valid
 * credential for real runs. The device store caps at 32 entries and evicts
 * oldest-first, so a handful of demo pairings can silently evict the
 * operator's actual phone.
 *
 * A stable, clearly-named sibling directory rather than scripts/smoke.mjs's
 * throwaway `mkdtemp` one: a demo is something a person runs more than once,
 * and it should be obvious on disk what it is and safe to delete.
 */
const DEMO_STORE_FILENAMES = {
  PRIME_WEB_PAIRING_TOKEN_FILE: "pairing-token",
  PRIME_WEB_DEVICE_STORE: "devices.json",
  PRIME_WEB_STATE_FILE: "gateway.json",
  PRIME_WEB_PUSH_STORE: "push-subscriptions.json",
} as const;

export function demoConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(configHome, "prime-agent-web-demo");
}

/**
 * `env` with the four store variables redirected into the demo directory.
 * Used both to load the CLI's own config (for `status`/`stop`/`token`) and,
 * unaltered otherwise, as the environment the demo gateway child is spawned
 * with — the child recomputes its own config from its own environment, so
 * redirecting only the CLI's view would leave the spawned process reading
 * the real stores right back out from under this.
 */
export function demoEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = demoConfigDir(env);
  const overrides = Object.fromEntries(
    Object.entries(DEMO_STORE_FILENAMES).map(([variable, filename]) => [variable, path.join(dir, filename)]),
  );
  return { ...env, ...overrides };
}
