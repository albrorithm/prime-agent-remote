import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BUILD_ID_PATTERN = /const BUILD_ID = "dev";/;

/**
 * Rewrites the built dist/sw.js placeholder BUILD_ID with a hash derived from
 * the built shell (index.html plus the fingerprinted asset filenames Vite
 * produced). This makes the service worker's cache name change automatically
 * whenever the shell actually changes, instead of relying on a hand-bumped
 * literal that's easy to forget — a stale one silently freezes offline users
 * on the previous shell. Returns the derived build id, or null if there was
 * nothing to patch (no sw.js in outDir, or it no longer has the placeholder).
 */
export function hashBuiltServiceWorker(outDir) {
  const swPath = join(outDir, "sw.js");
  if (!existsSync(swPath)) return null;

  const source = readFileSync(swPath, "utf8");
  if (!BUILD_ID_PATTERN.test(source)) return null;

  const hash = createHash("sha256");
  const indexPath = join(outDir, "index.html");
  if (existsSync(indexPath)) hash.update(readFileSync(indexPath));
  const assetsDir = join(outDir, "assets");
  if (existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir).sort()) hash.update(name);
  }
  const buildId = hash.digest("hex").slice(0, 12);

  writeFileSync(swPath, source.replace(BUILD_ID_PATTERN, `const BUILD_ID = "${buildId}";`));
  return buildId;
}

/**
 * Whether this module is the program being run, rather than a library import
 * (used by its own test). Comparing `import.meta.url` — the RESOLVED module
 * URL — against a naive `file://${process.argv[1]}` leaves anything that
 * needs percent-encoding unescaped, so a checkout in a directory with a space
 * in its name made the comparison false. The script then exited 0 having
 * printed nothing, and `dist/sw.js` shipped with `BUILD_ID = "dev"`: every
 * installed PWA freezes on its first cached shell, which is the exact
 * failure this script exists to prevent. `pathToFileURL(realpathSync(...))`
 * is the same fix `src/cli/index.ts`'s `isProgramEntry` already needed for
 * the identical bug.
 */
export function isProgramEntry(entry, moduleUrl, resolve = realpathSync) {
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}

// Allow running directly as a postbuild step: node scripts/hash-sw.mjs [outDir]
if (isProgramEntry(process.argv[1], import.meta.url)) {
  const outDir = process.argv[2] ?? "dist";
  const buildId = hashBuiltServiceWorker(outDir);
  if (buildId) {
    console.log(`sw.js cache name pinned to build ${buildId}`);
  } else {
    // Loud, not a no-op: this runs as `&&`-chained build step in package.json,
    // and silently continuing here is how a build shipped an unpatched
    // service worker without the chain ever noticing.
    console.error(`sw.js in ${outDir} not patched (missing file or placeholder) — refusing to ship an unpinned BUILD_ID`);
    process.exitCode = 1;
  }
}
