import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { isProgramEntry } from "./hash-sw.mjs";

/**
 * The entry-point check is the whole reason this file exists.
 *
 * When it misfires the script does not crash — it exits 0 having patched
 * nothing, and the build's `&&` chain carries on and ships `dist/sw.js` with
 * `BUILD_ID = "dev"`. Every installed PWA then freezes on the first shell it
 * cached, which is precisely the failure this script was written to prevent.
 * A silent no-op is the dangerous outcome here, so the path shapes that
 * produce one are worth pinning down.
 */
describe("isProgramEntry", () => {
  // The bug: `file://${entry}` leaves a space unescaped, so it never equals
  // import.meta.url, which is percent-encoded. Checkouts under iCloud or
  // "Application Support" hit this and nothing said so.
  it("matches a path containing a space", () => {
    const entry = "/Users/someone/My Projects/app/scripts/hash-sw.mjs";
    const moduleUrl = pathToFileURL(entry).href;
    expect(moduleUrl).toContain("%20");
    expect(isProgramEntry(entry, moduleUrl, (path) => path)).toBe(true);
  });

  it("matches other characters that need percent-encoding", () => {
    for (const entry of [
      "/tmp/a#b/hash-sw.mjs",
      "/tmp/a?b/hash-sw.mjs",
      "/tmp/ünïcode/hash-sw.mjs",
      "/tmp/two  spaces/hash-sw.mjs",
    ]) {
      expect(isProgramEntry(entry, pathToFileURL(entry).href, (path) => path)).toBe(true);
    }
  });

  it("resolves through a symlink, so a linked bin still counts as the entry", () => {
    const real = "/real/checkout/scripts/hash-sw.mjs";
    const linked = "/usr/local/bin/hash-sw.mjs";
    expect(isProgramEntry(linked, pathToFileURL(real).href, () => real)).toBe(true);
  });

  it("does not match a different program", () => {
    const entry = "/tmp/project/scripts/other-script.mjs";
    const moduleUrl = pathToFileURL("/tmp/project/scripts/hash-sw.mjs").href;
    expect(isProgramEntry(entry, moduleUrl, (path) => path)).toBe(false);
  });

  it("returns false rather than throwing when there is no entry", () => {
    expect(isProgramEntry(undefined, "file:///anything")).toBe(false);
    expect(isProgramEntry("", "file:///anything")).toBe(false);
  });

  it("returns false rather than throwing when the path cannot be resolved", () => {
    const explode = () => { throw new Error("ENOENT"); };
    expect(isProgramEntry("/gone/hash-sw.mjs", "file:///gone/hash-sw.mjs", explode)).toBe(false);
  });
});
