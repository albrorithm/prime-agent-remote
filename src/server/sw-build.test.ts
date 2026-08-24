import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBuiltServiceWorker } from "../../scripts/hash-sw.mjs";

const projectRoot = process.cwd();

let outDir: string;

function writeStubShell(indexHtml: string, assetNames: string[]) {
  writeFileSync(join(outDir, "index.html"), indexHtml);
  const assetsDir = join(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  for (const name of assetNames) writeFileSync(join(assetsDir, name), "");
}

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "sw-build-test-"));
  writeFileSync(join(outDir, "sw.js"), readFileSync(join(projectRoot, "public/sw.js"), "utf8"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("hashBuiltServiceWorker", () => {
  it("still ships a valid dev fallback in the unbuilt source", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(join(projectRoot, "public/sw.js"), "utf8"));
    expect(source).toContain('const BUILD_ID = "dev";');
    expect(source).not.toMatch(/CACHE_NAME = `\$\{CACHE_PREFIX\}v\d+`/);
  });

  it("replaces the dev placeholder with a hash of the built shell", () => {
    writeStubShell("<html>shell</html>", ["index-abc123.js", "index-def456.css"]);
    const buildId = hashBuiltServiceWorker(outDir);
    const patched = readFileSync(join(outDir, "sw.js"), "utf8");

    expect(buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(patched).toContain(`const BUILD_ID = "${buildId}";`);
    expect(patched).not.toContain('const BUILD_ID = "dev";');
  });

  it("leaves the rest of the worker untouched", () => {
    writeStubShell("<html>shell</html>", ["index-abc123.js"]);
    const original = readFileSync(join(outDir, "sw.js"), "utf8");
    hashBuiltServiceWorker(outDir);
    const patched = readFileSync(join(outDir, "sw.js"), "utf8");

    expect(patched.replace(/const BUILD_ID = "[^"]+";/, "")).toBe(original.replace(/const BUILD_ID = "dev";/, ""));
  });

  it("produces the same build id for an unchanged shell and a different one for a changed shell", () => {
    writeStubShell("<html>shell v1</html>", ["index-abc123.js", "index-def456.css"]);
    const first = hashBuiltServiceWorker(outDir);

    const otherDir = mkdtempSync(join(tmpdir(), "sw-build-test-"));
    try {
      writeFileSync(join(otherDir, "sw.js"), readFileSync(join(projectRoot, "public/sw.js"), "utf8"));
      mkdirSync(join(otherDir, "assets"), { recursive: true });
      writeFileSync(join(otherDir, "index.html"), "<html>shell v1</html>");
      writeFileSync(join(otherDir, "assets", "index-abc123.js"), "");
      writeFileSync(join(otherDir, "assets", "index-def456.css"), "");
      const second = hashBuiltServiceWorker(otherDir);
      expect(second).toBe(first);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }

    writeStubShell("<html>shell v2 (changed)</html>", ["index-abc123.js", "index-def456.css"]);
    const changed = hashBuiltServiceWorker(outDir);
    expect(changed).not.toBe(first);
  });

  it("does nothing when there is no sw.js to patch", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "sw-build-test-"));
    try {
      expect(hashBuiltServiceWorker(emptyDir)).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("is wired into the npm build script so a real `npm run build` always runs it", async () => {
    const pkg = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(projectRoot, "package.json"), "utf8")));
    expect(pkg.scripts.build).toContain("node scripts/hash-sw.mjs");
  });
});
