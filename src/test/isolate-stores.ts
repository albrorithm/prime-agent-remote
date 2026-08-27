import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point every operator-facing store at a throw-away directory, for the whole
 * suite.
 *
 * These paths default to the operator's real config directory. A test that
 * pairs a device, writes gateway state, or rotates a pairing token therefore
 * writes to the machine running the tests unless it remembers to redirect all
 * four — and `src/server/index.test.ts` redirected only the push store, so
 * every `npm test` paid three real device credentials into
 * ~/.config/prime-agent-web/devices.json. The store evicts by insertion order
 * at MAX_DEVICES, so enough runs would silently unpair the operator's phone.
 *
 * Setting them here rather than per test file means a spawned gateway inherits
 * the redirect through process.env, and a future test cannot leak by
 * forgetting. Individual files may still redirect explicitly; this is the
 * floor, not a substitute.
 */
const stores = mkdtempSync(join(tmpdir(), "prime-web-test-stores-"));

for (const [name, file] of [
  ["PRIME_WEB_DEVICE_STORE", "devices.json"],
  ["PRIME_WEB_PUSH_STORE", "push-subscriptions.json"],
  ["PRIME_WEB_PAIRING_TOKEN_FILE", "pairing-token"],
  ["PRIME_WEB_STATE_FILE", "gateway.json"],
] as const) {
  process.env[name] = join(stores, file);
}
