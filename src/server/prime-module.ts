import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

export type PrimeModuleOrigin = "env" | "dependency" | "global" | "sibling";

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
 * real dependency, then the global install, then a checkout sitting beside
 * this one.
 */
export function primeModuleCandidates({ env = process.env, globalRoot }: CandidateOptions = {}): PrimeModuleCandidate[] {
  const candidates: PrimeModuleCandidate[] = [];
  const configured = env.PRIME_AGENT_MODULE?.trim();
  if (configured) candidates.push({ specifier: configured, origin: "env" });
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
 * How Prime Agent is actually installed. Not `npm install -g prime-agent`:
 * that package does not exist on the registry and never has, so the previous
 * message sent anyone who hit it — which is precisely the people who do not
 * have Prime Agent — to a 404. Its own installer places the package under the
 * global node_modules this module already searches, which is why resolution
 * was right while the instruction was wrong.
 */
export const PRIME_INSTALL_COMMAND = "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh";

export class PrimeModuleResolutionError extends Error {
  constructor(readonly attempted: PrimeModuleCandidate[]) {
    super(
      attempted.length === 0
        ? `Could not find a Prime Agent build. Install it with \`${PRIME_INSTALL_COMMAND}\`.`
        : `Could not load a Prime Agent build exporting ${REQUIRED_PRIME_EXPORTS.join(", ")}. Tried:\n`
          + attempted.map((c) => `  - ${c.specifier} (${c.origin})`).join("\n")
          + `\n\nInstall Prime Agent with \`${PRIME_INSTALL_COMMAND}\`, or set PRIME_AGENT_MODULE`
          + ` to a built module that exports them.`,
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
  const root = globalRoot ?? (await globalNodeModulesRoot());
  const candidates = primeModuleCandidates({ env, globalRoot: root });
  const attempted: PrimeModuleCandidate[] = [];
  for (const candidate of candidates) {
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
