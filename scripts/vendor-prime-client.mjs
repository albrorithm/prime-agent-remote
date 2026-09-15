#!/usr/bin/env node
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

// Offline regeneration from the reviewed upstream source archive. Never runs
// upstream build/install scripts. Normal Remote builds use the checked-in client.
const commit = "878410b3981f20c6d685faa210ad0e43426cf483";
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error("Usage: node scripts/vendor-prime-client.mjs <upstream-source> [--check]");
if (version !== "0.28.2") throw new Error("Regeneration requires esbuild 0.28.2");
const destination = fileURLToPath(new URL("../vendor/prime-daemon/", import.meta.url));
const entry = [
  'export { DaemonClient } from "./packages/coding-agent/src/modes/daemon/daemon-client.ts";',
  'export { DaemonAgentConnection } from "./packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts";',
  'export { defaultDaemonSocketPath } from "./packages/coding-agent/src/modes/daemon/daemon-socket.ts";',
].join("\n");
const result = await build({
  absWorkingDir: source,
  stdin: { contents: entry, resolveDir: source, sourcefile: "remote-daemon-entry.ts" },
  bundle: true, platform: "node", format: "esm", target: "node22",
  write: false, metafile: true, legalComments: "inline",
  banner: { js: `// Generated from PrimeIntellect-ai/prime-agent ${commit}. See provenance.json and LICENSE.` },
  plugins: [{ name: "omit-unused-lock-imports", setup(context) {
    // The client only imports the lease error class and socket path helper.
    // Their unused locking functions are tree-shaken. Fail below if any
    // non-Node dependency survives; do not stub runtime functionality.
    context.onResolve({ filter: /^proper-lockfile$/ }, () => ({ path: "proper-lockfile", external: true, sideEffects: false }));
  } }],
});
const output = Object.values(result.metafile.outputs)[0];
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
if (output.imports.some((item) => !builtins.has(item.path))) throw new Error("Client acquired an external runtime dependency");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputs = {};
for (const name of Object.keys(result.metafile.inputs).sort()) {
  const absolute = resolve(source, name);
  if (absolute === resolve(source, "remote-daemon-entry.ts")) continue;
  if (relative(source, absolute).startsWith("..")) throw new Error("Input outside upstream source");
  inputs[name] = hash(await readFile(absolute));
}
const bundle = result.outputFiles[0].text;
const provenance = { repository: "https://github.com/PrimeIntellect-ai/prime-agent", commit,
  upstreamVersion: "0.9.4", protocol: 7, schema: 28, esbuild: version,
  bundleSha256: hash(bundle), inputs };
const provenancePath = resolve(destination, "provenance.json");
const existing = await readFile(provenancePath, "utf8").catch(() => null);
if (existing && JSON.stringify(JSON.parse(existing)) !== JSON.stringify(provenance)) {
  throw new Error("Source or generated client differs from the reviewed provenance; review before updating the pin");
}
if (process.argv.includes("--check")) {
  if (!existing || await readFile(resolve(destination, "index.js"), "utf8") !== bundle) throw new Error("Vendored client differs");
  console.log("Pinned daemon client reproduces exactly");
} else {
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, "index.js"), bundle);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(resolve(destination, "LICENSE"), await readFile(resolve(source, "LICENSE")));
  await writeFile(resolve(destination, "package.json"), `${JSON.stringify({
    name: "prime-agent-remote-daemon-client", private: true, type: "module", version: "0.9.4+878410b",
    license: "MIT", piConfig: { name: "prime-agent", configDir: ".prime/agent" },
  }, null, 2)}\n`);
  console.log(`Vendored daemon client: ${Buffer.byteLength(bundle)} bytes`);
}
