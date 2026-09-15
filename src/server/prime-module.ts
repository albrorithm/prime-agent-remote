import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The three daemon exports this gateway needs. They are checked by name at
 * load time because more than one package has claimed the "Prime Agent"
 * name on npm and only some builds carry the daemon client.
 */
export const REQUIRED_PRIME_EXPORTS = ["DaemonClient", "DaemonAgentConnection", "defaultDaemonSocketPath"] as const;

/**
 * The package that actually ships the daemon client. `@earendil-works/pi-coding-agent`
 * is the older publish line and its current registry versions contain none of
 * REQUIRED_PRIME_EXPORTS, so it is deliberately not a fallback: pointing at it
 * produces a confusing "incompatible build" error rather than a missing one.
 */
export const PRIME_PACKAGE_NAME = "prime-agent";
export const BUNDLED_PRIME_MODULE = fileURLToPath(new NodeURL("../../vendor/prime-daemon/index.js", import.meta.url));

export type PrimeModuleOrigin = "env" | "dependency" | "global" | "sibling" | "bundled";

export interface PrimeModuleCandidate {
  specifier: string;
  origin: PrimeModuleOrigin;
}

export interface PrimeModuleResolution extends PrimeModuleCandidate {
  module: Record<string, unknown>;
}

export function hasRequiredPrimeExports(loaded: unknown): boolean {
  if (loaded == null || typeof loaded !== "object") return false;
  const module = loaded as Record<string, unknown>;
  return REQUIRED_PRIME_EXPORTS.every((name) => module[name] != null);
}

/**
 * A relative or absolute path has to become a file URL before `import()` will
 * take it; a bare specifier must be left alone so Node resolves it normally.
 */
export function toImportSpecifier(specifier: string): string {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(process.cwd(), specifier)).href;
  }
  return specifier;
}

/**
 * Prime Agent is normally a global install, which a bare `import()` from this
 * package cannot see. `npm root -g` is the only reliable way to find it:
 * deriving the path from `process.execPath` is wrong on Homebrew, where Node
 * lives under a versioned Cellar directory while the global root does not.
 */
export async function globalNodeModulesRoot(
  run: () => Promise<string> = async () => (await execFileAsync("npm", ["root", "-g"], { timeout: 10_000 })).stdout,
): Promise<string | undefined> {
  try {
    const root = (await run()).trim();
    return root ? root : undefined;
  } catch {
    // No npm on PATH, or it failed. Resolution continues without this source.
    return undefined;
  }
}

export interface CandidateOptions {
  env?: NodeJS.ProcessEnv;
  globalRoot?: string;
}

/**
 * Ordered by how specific the signal is: an operator's explicit choice, then a
 * pinned bundled client, then legacy local/global SDK discovery. This avoids
 * silently using a retained old SDK after native CLI migration.
 */
export function primeModuleCandidates({ env = process.env, globalRoot }: CandidateOptions = {}): PrimeModuleCandidate[] {
  const candidates: PrimeModuleCandidate[] = [];
  const configured = env.PRIME_AGENT_MODULE?.trim();
  if (configured) candidates.push({ specifier: configured, origin: "env" });
  candidates.push({ specifier: BUNDLED_PRIME_MODULE, origin: "bundled" });
  candidates.push({ specifier: PRIME_PACKAGE_NAME, origin: "dependency" });
  if (globalRoot) {
    candidates.push({ specifier: path.join(globalRoot, PRIME_PACKAGE_NAME), origin: "global" });
  }
  return candidates;
}

/**
 * ESM will not import a directory: unlike CommonJS there is no index.js
 * lookup and no package.json resolution for a plain path. A discovered
 * package therefore has to be expanded to its real entry file, honouring
 * `exports["."]` before the legacy `main`.
 */
export function packageEntryPoint(manifest: unknown): string | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const pkg = manifest as Record<string, unknown>;
  const dot = (pkg.exports as Record<string, unknown> | undefined)?.["."];
  if (typeof dot === "string") return dot;
  if (dot != null && typeof dot === "object") {
    const conditions = dot as Record<string, unknown>;
    for (const key of ["import", "module", "default", "require"]) {
      const value = conditions[key];
      if (typeof value === "string") return value;
    }
  }
  for (const key of ["module", "main"]) {
    const value = pkg[key];
    if (typeof value === "string") return value;
  }
  return "index.js";
}

export interface ResolveOptions extends CandidateOptions {
  load?: (specifier: string) => Promise<unknown>;
  expand?: (specifier: string) => Promise<string>;
}

/**
 * Leaves bare specifiers, data URLs, and plain files untouched; only a real
 * directory is expanded through its manifest.
 */
export async function expandPackageDirectory(specifier: string): Promise<string> {
  if (!path.isAbsolute(specifier)) return specifier;
  try {
    if (!(await stat(specifier)).isDirectory()) return specifier;
    const manifest = JSON.parse(await readFile(path.join(specifier, "package.json"), "utf8")) as unknown;
    return path.join(specifier, packageEntryPoint(manifest) ?? "index.js");
  } catch {
    return specifier;
  }
}

/**
 * The version of the package a resolved specifier lives in: the nearest
 * package.json above it, read once. Null for anything that is not a file on
 * disk, or when no manifest turns up within a few levels, which is "unknown"
 * and is reported as such rather than guessed at.
 */
export async function readPackageVersion(specifier: string): Promise<string | null> {
  if (!path.isAbsolute(specifier)) return null;
  let directory = path.dirname(specifier);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as { version?: unknown };
      return typeof manifest.version === "string" && manifest.version.length <= 64 ? manifest.version : null;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  return null;
}

/**
 * Installs the agent application. Native channels do not supply an importable
 * SDK; Remote's bundled client is distributed separately from that application.
 */
export const PRIME_INSTALL_COMMAND = "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh";

export class PrimeModuleResolutionError extends Error {
  constructor(readonly attempted: PrimeModuleCandidate[]) {
    super(
      `Could not load the bundled Prime daemon client. Reinstall @albrorithm/prime-agent-remote,`
      + ` or set PRIME_AGENT_MODULE to a compatible JavaScript SDK. A native Prime executable is not an SDK.`
      + `\nTried:\n` + attempted.map((c) => `  - ${c.specifier} (${c.origin})`).join("\n"),
    );
    this.name = "PrimeModuleResolutionError";
  }
}

/**
 * Tries each candidate in order and returns the first that loads AND carries
 * the required exports. A candidate that imports cleanly but lacks them is not
 * an error on its own: an older build can occupy the package name while a
 * usable one sits further down the list.
 */
export async function resolvePrimeModule({
  env = process.env,
  globalRoot,
  load = (specifier) => import(specifier),
  expand = expandPackageDirectory,
}: ResolveOptions = {}): Promise<PrimeModuleResolution> {
  async function* candidates(): AsyncGenerator<PrimeModuleCandidate> {
    yield* primeModuleCandidates({ env, globalRoot });
    // Native installations need neither npm nor a legacy package. Only ask
    // npm about its global root after the bundled client has actually failed.
    if (globalRoot === undefined) {
      const root = await globalNodeModulesRoot();
      if (root) yield { specifier: path.join(root, PRIME_PACKAGE_NAME), origin: "global" };
    }
  }
  const attempted: PrimeModuleCandidate[] = [];
  for await (const candidate of candidates()) {
    let specifier = candidate.specifier;
    let loaded: unknown;
    try {
      specifier = await expand(candidate.specifier);
      attempted.push({ ...candidate, specifier });
      loaded = await load(toImportSpecifier(specifier));
    } catch {
      continue;
    }
    if (hasRequiredPrimeExports(loaded)) {
      return { ...candidate, specifier, module: loaded as Record<string, unknown> };
    }
  }
  throw new PrimeModuleResolutionError(attempted);
}
