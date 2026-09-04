import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_FILE_VARIABLES } from "../server/config.js";

/**
 * The persistent paths `--demo` must never share with a real run: pairing
 * token, paired-device list, gateway state, push subscriptions, and the VAPID
 * keypair. `src/server/config.ts` derives them all from the same
 * `~/.config/prime-agent-web/` regardless of backend, so without this, demo
 * mode prints the operator's REAL pairing token, and a device paired during a
 * demo becomes a valid credential for real runs. The device store caps at 32
 * entries and evicts oldest-first, so a handful of demo pairings can silently
 * evict the operator's actual phone.
 *
 * Keyed by `CONFIG_FILE_VARIABLES` rather than listed by hand: a hand-kept
 * list missed the VAPID key file once already, and the demo minted its keys
 * into the real directory. `satisfies` makes a new config file a compile error
 * here until it has a demo name too.
 *
 * A stable, clearly-named sibling directory rather than scripts/smoke.mjs's
 * throwaway `mkdtemp` one: a demo is something a person runs more than once,
 * and it should be obvious on disk what it is and safe to delete.
 */
const DEMO_STORE_FILENAMES = {
  pairingTokenPath: "pairing-token",
  deviceStorePath: "devices.json",
  gatewayStatePath: "gateway.json",
  webPushStorePath: "push-subscriptions.json",
  vapidKeysPath: "vapid-keys.json",
} as const satisfies Record<keyof typeof CONFIG_FILE_VARIABLES, string>;

export function demoConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(configHome, "prime-agent-web-demo");
}

/**
 * `env` with every store variable redirected into the demo directory.
 * Used both to load the CLI's own config (for `status`/`stop`/`token`) and,
 * unaltered otherwise, as the environment the demo gateway child is spawned
 * with — the child recomputes its own config from its own environment, so
 * redirecting only the CLI's view would leave the spawned process reading
 * the real stores right back out from under this.
 */
export function demoEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = demoConfigDir(env);
  const overrides = Object.fromEntries(
    (Object.keys(CONFIG_FILE_VARIABLES) as Array<keyof typeof CONFIG_FILE_VARIABLES>)
      .map((field) => [CONFIG_FILE_VARIABLES[field], path.join(dir, DEMO_STORE_FILENAMES[field])]),
  );
  return { ...env, ...overrides };
}
