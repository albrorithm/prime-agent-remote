#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Builds dist/ and dist-server/ for whoever's `npm install` needed them.
 *
 * `prepare` is the one npm lifecycle script documented to run both for a
 * plain local `npm install` in a dev checkout, and for `npm install -g
 * git+…` of this package — npm installs devDependencies for exactly that
 * second case specifically so a git dependency can build itself here.
 * Without this, `npm install -g git+https://github.com/albrorithm/prime-agent-remote.git`
 * leaves the bin entry (dist-server/cli/index.js) never built, and every
 * subcommand ENOENTs.
 *
 * Guarded rather than a bare `npm run build`: an install that used
 * --omit=dev has neither vite nor tsc on disk, and failing the whole install
 * over a build nobody asked for is worse than skipping it quietly — this
 * package has no runtime API, only a CLI, and an --omit=dev install of a CLI
 * package is not going to run that CLI from node_modules either way.
 */
const devDependenciesPresent = existsSync(join(process.cwd(), "node_modules", "vite"))
  && existsSync(join(process.cwd(), "node_modules", "typescript"));

if (!devDependenciesPresent) {
  console.log("prime-agent-remote: devDependencies not installed; skipping the build.");
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
process.exit(result.status ?? 1);
