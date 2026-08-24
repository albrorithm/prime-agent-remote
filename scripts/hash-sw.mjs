import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// Allow running directly as a postbuild step: node scripts/hash-sw.mjs [outDir]
if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ?? "dist";
  const buildId = hashBuiltServiceWorker(outDir);
  console.log(buildId ? `sw.js cache name pinned to build ${buildId}` : `sw.js in ${outDir} not patched (missing file or placeholder)`);
}
