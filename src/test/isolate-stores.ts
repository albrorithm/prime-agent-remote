import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_VARIABLES } from "../server/config.js";

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
 *
 * Enumerated from `CONFIG_FILE_VARIABLES` rather than listed by hand, the way
 * `src/server/index.test.ts` already does it. The hand-kept list this replaces
 * was missing `PRIME_WEB_VAPID_KEY_FILE` — one of the five — which is the same
 * shape of leak the paragraph above describes, recurring because the list had
 * to be remembered. Derived, a new store is redirected the moment it is added
 * to the config.
 */
const stores = mkdtempSync(join(tmpdir(), "prime-web-test-stores-"));

for (const [field, variable] of Object.entries(CONFIG_FILE_VARIABLES)) {
  process.env[variable] = join(stores, `${field}.json`);
}
