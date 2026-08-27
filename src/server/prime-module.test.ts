import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PRIME_INSTALL_COMMAND,
  PRIME_PACKAGE_NAME,
  PrimeModuleResolutionError,
  REQUIRED_PRIME_EXPORTS,
  expandPackageDirectory,
  globalNodeModulesRoot,
  hasRequiredPrimeExports,
  packageEntryPoint,
  primeModuleCandidates,
  resolvePrimeModule,
  toImportSpecifier,
} from "./prime-module.js";

const GLOBAL_ROOT = path.join(path.sep, "usr", "local", "lib", "node_modules");

function compatibleModule(): Record<string, unknown> {
  return {
    DaemonClient: class {},
    DaemonAgentConnection: { attach: () => {} },
    defaultDaemonSocketPath: () => "/tmp/daemon.sock",
  };
}

describe("hasRequiredPrimeExports", () => {
  it("accepts a module carrying all three daemon exports", () => {
    expect(hasRequiredPrimeExports(compatibleModule())).toBe(true);
  });

  it("rejects a module missing any one of them", () => {
    for (const name of REQUIRED_PRIME_EXPORTS) {
      const partial = compatibleModule();
      delete partial[name];
      expect(hasRequiredPrimeExports(partial)).toBe(false);
    }
  });

  it("rejects non-objects rather than throwing", () => {
    expect(hasRequiredPrimeExports(undefined)).toBe(false);
    expect(hasRequiredPrimeExports(null)).toBe(false);
    expect(hasRequiredPrimeExports("prime-agent")).toBe(false);
  });
});

describe("toImportSpecifier", () => {
  it("leaves a bare specifier alone so Node resolves it normally", () => {
    expect(toImportSpecifier(PRIME_PACKAGE_NAME)).toBe(PRIME_PACKAGE_NAME);
  });

  it("converts an absolute path to a file URL", () => {
    const absolute = path.join(GLOBAL_ROOT, PRIME_PACKAGE_NAME);
    expect(toImportSpecifier(absolute)).toBe(pathToFileURL(absolute).href);
  });

  it("resolves a relative path before converting it", () => {
    expect(toImportSpecifier("./build/index.js")).toBe(
      pathToFileURL(path.resolve(process.cwd(), "./build/index.js")).href,
    );
  });
});

describe("primeModuleCandidates", () => {
  it("puts an explicit PRIME_AGENT_MODULE ahead of every discovered source", () => {
    const candidates = primeModuleCandidates({
      env: { PRIME_AGENT_MODULE: "/opt/build/index.js" },
      globalRoot: GLOBAL_ROOT,
    });
    expect(candidates[0]).toEqual({ specifier: "/opt/build/index.js", origin: "env" });
  });

  it("offers the bare package before the global install", () => {
    const origins = primeModuleCandidates({ env: {}, globalRoot: GLOBAL_ROOT }).map((c) => c.origin);
    expect(origins).toEqual(["dependency", "global"]);
  });

  it("omits the global candidate when no global root was found", () => {
    const candidates = primeModuleCandidates({ env: {} });
    expect(candidates).toEqual([{ specifier: PRIME_PACKAGE_NAME, origin: "dependency" }]);
  });

  it("ignores a blank PRIME_AGENT_MODULE instead of trying an empty specifier", () => {
    const candidates = primeModuleCandidates({ env: { PRIME_AGENT_MODULE: "   " } });
    expect(candidates.every((c) => c.origin !== "env")).toBe(true);
  });
});

describe("globalNodeModulesRoot", () => {
  it("trims the trailing newline npm prints", async () => {
    await expect(globalNodeModulesRoot(async () => `${GLOBAL_ROOT}\n`)).resolves.toBe(GLOBAL_ROOT);
  });

  it("returns undefined when npm is unavailable rather than failing startup", async () => {
    await expect(globalNodeModulesRoot(async () => { throw new Error("npm not found"); })).resolves.toBeUndefined();
  });

  it("treats empty output as no answer", async () => {
    await expect(globalNodeModulesRoot(async () => "\n")).resolves.toBeUndefined();
  });
});

describe("resolvePrimeModule", () => {
  it("resolves the global install when the package is not a local dependency", async () => {
    const tried: string[] = [];
    const resolution = await resolvePrimeModule({
      env: {},
      globalRoot: GLOBAL_ROOT,
      load: async (specifier) => {
        tried.push(specifier);
        if (specifier === PRIME_PACKAGE_NAME) throw new Error("ERR_MODULE_NOT_FOUND");
        return compatibleModule();
      },
    });
    expect(resolution.origin).toBe("global");
    expect(resolution.specifier).toBe(path.join(GLOBAL_ROOT, PRIME_PACKAGE_NAME));
    expect(tried[0]).toBe(PRIME_PACKAGE_NAME);
  });

  it("skips a candidate that loads but lacks the daemon exports", async () => {
    // The exact shape of the current @earendil-works/pi-coding-agent registry
    // line: it imports cleanly and exports none of what the gateway needs.
    const resolution = await resolvePrimeModule({
      env: { PRIME_AGENT_MODULE: "@earendil-works/pi-coding-agent" },
      globalRoot: GLOBAL_ROOT,
      load: async (specifier) =>
        specifier === "@earendil-works/pi-coding-agent" ? { createAgentSession: () => {} } : compatibleModule(),
    });
    expect(resolution.origin).toBe("dependency");
  });

  it("prefers an explicit module over a working global install", async () => {
    const resolution = await resolvePrimeModule({
      env: { PRIME_AGENT_MODULE: "/opt/build/index.js" },
      globalRoot: GLOBAL_ROOT,
      load: async () => compatibleModule(),
    });
    expect(resolution.origin).toBe("env");
  });

  it("reports every attempted specifier when nothing works", async () => {
    const error = await resolvePrimeModule({
      env: {},
      globalRoot: GLOBAL_ROOT,
      load: async () => { throw new Error("ERR_MODULE_NOT_FOUND"); },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrimeModuleResolutionError);
    const message = (error as Error).message;
    expect(message).toContain(PRIME_PACKAGE_NAME);
    expect(message).toContain(path.join(GLOBAL_ROOT, PRIME_PACKAGE_NAME));
    // The instruction has to be one that works: `npm install -g prime-agent`
      // resolves to nothing on the registry.
      expect(message).toContain(PRIME_INSTALL_COMMAND);
  });
});

describe("packageEntryPoint", () => {
  it("prefers the import condition of exports[\".\"]", () => {
    expect(packageEntryPoint({
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      main: "./legacy.js",
    })).toBe("./dist/index.js");
  });

  it("accepts a string exports[\".\"]", () => {
    expect(packageEntryPoint({ exports: { ".": "./dist/index.js" } })).toBe("./dist/index.js");
  });

  it("falls back to main when there are no exports", () => {
    expect(packageEntryPoint({ main: "./dist/index.js" })).toBe("./dist/index.js");
  });

  it("falls back to index.js for a manifest declaring no entry at all", () => {
    expect(packageEntryPoint({ name: "prime-agent" })).toBe("index.js");
  });

  it("returns undefined for a non-object manifest", () => {
    expect(packageEntryPoint(undefined)).toBeUndefined();
    expect(packageEntryPoint("not a manifest")).toBeUndefined();
  });
});

describe("expandPackageDirectory", () => {
  it("leaves a bare specifier alone", async () => {
    await expect(expandPackageDirectory(PRIME_PACKAGE_NAME)).resolves.toBe(PRIME_PACKAGE_NAME);
  });

  it("leaves a path that is not a directory alone", async () => {
    const missing = path.join(GLOBAL_ROOT, "definitely-not-here", "index.js");
    await expect(expandPackageDirectory(missing)).resolves.toBe(missing);
  });
});

describe("resolvePrimeModule directory expansion", () => {
  it("imports a discovered package's entry file, because ESM cannot import a directory", async () => {
    const directory = path.join(GLOBAL_ROOT, PRIME_PACKAGE_NAME);
    const entry = path.join(directory, "dist", "index.js");
    const imported: string[] = [];
    const resolution = await resolvePrimeModule({
      env: {},
      globalRoot: GLOBAL_ROOT,
      expand: async (specifier) => (specifier === directory ? entry : specifier),
      load: async (specifier) => {
        imported.push(specifier);
        if (specifier === PRIME_PACKAGE_NAME) throw new Error("ERR_MODULE_NOT_FOUND");
        return compatibleModule();
      },
    });
    expect(resolution.specifier).toBe(entry);
    expect(imported).toContain(pathToFileURL(entry).href);
    expect(imported).not.toContain(pathToFileURL(directory).href);
  });
});
