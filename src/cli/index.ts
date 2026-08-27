#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, constants, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../server/config.js";
import { loadOrCreatePairingToken, rotatePairingToken } from "../server/pairing-token.js";
import { resolvePrimeModule } from "../server/prime-module.js";
import { demoConfigDir, demoEnv } from "./demo-stores.js";
import { type ExposureMode, defaultExposureMode, resolveExposure, type Exposure } from "./exposure.js";
import { isPrimeWebGatewayResponse } from "./gateway-identity.js";
import { clearGatewayState, isProcessAlive, resolveStatus, writeGatewayState } from "./state.js";

const execFileAsync = promisify(execFile);

/**
 * Whether the thing answering on `host:port` is THIS gateway, not merely
 * something that accepted the connection — another process already on the
 * port, or this gateway's own predecessor still tearing down mid-restart.
 * `GET /api/v1/bootstrap` unauthenticated always 401s with a fixed body; see
 * `gateway-identity.ts` for why that is a safe thing to check without a
 * dedicated health endpoint.
 */
async function respondsAsGateway(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/v1/bootstrap`, { signal: AbortSignal.timeout(1_000) });
    const body: unknown = await response.json().catch(() => null);
    return isPrimeWebGatewayResponse(response.status, response.headers.get("content-type"), body);
  } catch {
    return false;
  }
}

/**
 * Waits until this gateway, specifically, is serving the port.
 *
 * A spawned process is not a serving one, and a serving process is not
 * necessarily this one. Reporting "running" from a live pid alone, or from
 * any TCP accept, is how a launcher ends up telling someone to open a URL
 * that refuses the connection or belongs to something else entirely, and how
 * an agent concludes a change is live when nothing is listening.
 */
async function waitForListening(host: string, port: number, timeoutMs = 15_000): Promise<boolean> {
  // A wildcard bind is not a connectable address; loopback is inside it.
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const origin = `http://${target}:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await respondsAsGateway(origin)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `prime-agent-mobile — a phone-sized web UI for Prime Agent

Usage:
  prime-agent-mobile start [options]     Start the gateway in the background
  prime-agent-mobile status [--demo]     Say whether it is running, and where
  prime-agent-mobile stop [--demo]       Stop it
  prime-agent-mobile token [--rotate] [--demo]   Print the setup token
  prime-agent-mobile rebuild [--demo]    Rebuild the UI and make it live
  prime-agent-mobile install-command     Add /webui to Prime Agent
  prime-agent-mobile help

--demo targets the demo instance, which keeps its own pairing token, paired
devices, and gateway state entirely separate from a real run — pass it to
status/stop/rebuild too, not just start, or they will look at the wrong one.

Options for start:
  --tailscale     Publish over your tailnet. HTTPS, phone-reachable. Default when available.
  --loopback      This machine only. No phone access.
  --lan           Experimental. Every device on your network can reach it.
  --port <n>      Gateway port (default 8787)
  --demo          Safe demo backend; never touches a real agent
  --foreground    Run in this terminal instead of the background
`;

interface Options {
  command: string;
  mode?: ExposureMode;
  port?: number;
  demo: boolean;
  foreground: boolean;
  rotate: boolean;
}

export function parseArguments(argv: readonly string[]): Options {
  const options: Options = { command: argv[0] ?? "help", demo: false, foreground: false, rotate: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tailscale" || argument === "--loopback" || argument === "--lan") {
      options.mode = argument.slice(2) as ExposureMode;
    } else if (argument === "--demo") options.demo = true;
    else if (argument === "--foreground") options.foreground = true;
    else if (argument === "--rotate") options.rotate = true;
    else if (argument === "--port") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value)) throw new Error(`--port needs a number, not ${argv[index + 1] ?? "nothing"}`);
      options.port = value;
      index += 1;
    } else throw new Error(`Unknown option ${argument}. Run \`prime-agent-mobile help\`.`);
  }
  return options;
}

/** The mDNS name a phone on the same network can resolve. */
export function localHostname(raw = hostname()): string {
  const name = raw.replace(/\.$/u, "");
  return name.includes(".") ? name : `${name}.local`;
}

async function tailscaleDnsName(): Promise<string | undefined> {
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const binary of candidates) {
    try {
      const { stdout } = await execFileAsync(binary, ["status", "--json"], { timeout: 10_000 });
      const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
      const name = status.Self?.DNSName?.replace(/\.$/u, "");
      if (name) return name;
    } catch {
      // Not installed here, or not running. Try the next candidate.
    }
  }
  return undefined;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function runBuild(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm run build exited ${code}`))));
  });
}

interface RebuildTarget {
  dir: string;
  previous: string;
}

/** `dist/` (the web app) and `dist-server/` (the gateway and this CLI). */
function rebuildTargets(): RebuildTarget[] {
  return [
    { dir: path.join(projectRoot, "dist"), previous: path.join(projectRoot, ".dist-previous") },
    { dir: path.join(projectRoot, "dist-server"), previous: path.join(projectRoot, ".dist-server-previous") },
  ];
}

/**
 * Rebuilds without risking the working app.
 *
 * The gateway serves `dist/` from disk and is itself compiled into
 * `dist-server/` — and `npm run build` deletes `dist-server/` up front, before
 * typecheck or compilation, so ANY build failure (one TS error is enough)
 * leaves it gone. A broken edit would then take down a working install rather
 * than merely failing to change it: the bin symlink points at a file that no
 * longer exists, so even `rebuild` itself cannot run again to fix it. Both
 * previous builds are moved aside first and put back if the new one does not
 * finish. That is what makes an edit cheap to undo, which matters more than
 * making it careful.
 */
async function safeRebuild(): Promise<boolean> {
  const targets = rebuildTargets();
  const backups = await Promise.all(targets.map(async (target) => {
    const hadBuild = await exists(target.dir);
    await rm(target.previous, { recursive: true, force: true });
    if (hadBuild) await rename(target.dir, target.previous);
    return { ...target, hadBuild };
  }));
  try {
    await runBuild();
    await Promise.all(backups.map((backup) => rm(backup.previous, { recursive: true, force: true })));
    return true;
  } catch (error) {
    line();
    line(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    let restoredAny = false;
    for (const backup of backups) {
      if (!backup.hadBuild) continue;
      await rm(backup.dir, { recursive: true, force: true });
      await rename(backup.previous, backup.dir);
      restoredAny = true;
    }
    // Said only when it is true: a fresh checkout with no previous dist/ or
    // dist-server/ has nothing to put back, and claiming otherwise is exactly
    // the false "the app still works" this function exists to prevent.
    if (restoredAny) line("The previous build was put back, so the app still works.");
    return false;
  }
}

async function ensureBuilt(): Promise<void> {
  const built = await exists(path.join(projectRoot, "dist", "index.html"))
    && await exists(path.join(projectRoot, "dist-server", "server", "index.js"));
  if (built) return;
  process.stdout.write("Building the app (first run only)...\n");
  await runBuild();
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

/**
 * What the environment loading `loadConfig` and the gateway child spawn from
 * both need: real by default, redirected to the demo-scoped store directory
 * when `--demo` is set. Computed once so the CLI's own view of "where is the
 * state file" and the child's view of "where is the device store" can never
 * disagree — they disagreed before, because only the pairing token was ever
 * passed to the child explicitly, and the other three persistent paths came
 * from the child recomputing config from `process.env` unmodified.
 */
function baseEnv(options: Pick<Options, "demo">): NodeJS.ProcessEnv {
  return options.demo ? demoEnv(process.env) : process.env;
}

function printStartupInfo(exposure: Exposure, token: string, port: number): void {
  line();
  line(`Running at ${exposure.url}`);
  line(`Setup token: ${token}`);
  line();
  if (exposure.mode === "tailscale") {
    line("Tailscale still needs to publish it once:");
    line(`  tailscale serve --bg http://127.0.0.1:${port}`);
    line();
  }
  for (const warning of exposure.warnings) line(`Note: ${warning}`);
  if (exposure.warnings.length > 0) line();
}

async function start(options: Options): Promise<number> {
  // Read without forcing production: the paths do not depend on it, and
  // production validation would reject an origin allowlist this function has
  // not computed yet. The gateway child gets NODE_ENV=production below.
  const env = baseEnv(options);
  const config = loadConfig(env);
  const status = await resolveStatus(config.gatewayStatePath);
  if (status.running && status.state) {
    line(`Already running at ${status.state.url} (pid ${status.state.pid}).`);
    line("Use `prime-agent-mobile stop` first, or `status` to see it.");
    return 1;
  }
  if (status.stale) await clearGatewayState(config.gatewayStatePath);

  const port = options.port ?? config.port;
  const backend = options.demo ? "demo" : "prime";

  line("Checking what is available...");
  const tailscaleHost = await tailscaleDnsName();
  line(tailscaleHost ? `  Tailscale: ${tailscaleHost}` : "  Tailscale: not running");

  if (backend === "prime") {
    try {
      const resolved = await resolvePrimeModule();
      line(`  Prime Agent: ${resolved.specifier}`);
    } catch (error) {
      line(`  Prime Agent: not found`);
      line();
      line(error instanceof Error ? error.message : String(error));
      line();
      line("Or start without it: `prime-agent-mobile start --demo`.");
      return 1;
    }
  } else {
    line("  Backend: demo (no real agent is reachable)");
    line(`  Demo stores: ${demoConfigDir(process.env)} — kept separate from your real pairing token and devices`);
  }

  const mode = options.mode ?? defaultExposureMode({ tailscale: Boolean(tailscaleHost) });
  const exposure = resolveExposure({ mode, port, tailscaleHost, localHostname: localHostname() });

  await ensureBuilt();

  const token = await loadOrCreatePairingToken(config.pairingTokenPath);
  // Built on `env`, not `process.env`: the child recomputes its own config
  // from its environment, so a demo run whose CLI-side paths were redirected
  // but whose spawn environment was not would still open the real devices.json.
  const environment: NodeJS.ProcessEnv = {
    ...env,
    NODE_ENV: "production",
    PRIME_WEB_BACKEND: backend,
    PRIME_WEB_HOST: exposure.host,
    PRIME_WEB_PORT: String(port),
    PRIME_WEB_ALLOWED_ORIGINS: exposure.origins.join(","),
    PRIME_WEB_SECURE_COOKIE: String(exposure.secureCookie),
    PRIME_WEB_PAIRING_TOKEN: token,
  };
  const entry = path.join(projectRoot, "dist-server", "server", "index.js");

  if (options.foreground) {
    // The background path prints the URL and token once the gateway proves
    // it is listening; this one hands the terminal straight to the child, so
    // it has to say them first — and only here can it, since passing
    // PRIME_WEB_PAIRING_TOKEN explicitly (above) means the child's own
    // `generatedPairingToken` is false and it never prints the token itself.
    printStartupInfo(exposure, token, port);
    line("Open that address on your phone and enter the setup token.");
    line();
    const child = spawn(process.execPath, [entry], { cwd: projectRoot, env: environment, stdio: "inherit" });
    return await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
  }

  // Detached, in its own process group, with the streams closed. The gateway
  // must not be a child of whatever started it: a Prime Agent extension runs
  // inside a worker process, and `prime-agent shutdown --force` terminates
  // worker process groups and their tracked children. A gateway owned by one
  // would die with the session that happened to launch it.
  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: environment,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) {
    line("Could not start the gateway.");
    return 1;
  }

  if (!await waitForListening(exposure.host, port)) {
    line();
    line(`The gateway started (pid ${child.pid}) but nothing is listening on port ${port}.`);
    line("Run `prime-agent-mobile start --foreground` to see why.");
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    return 1;
  }

  await writeGatewayState(config.gatewayStatePath, {
    pid: child.pid,
    url: exposure.url,
    host: exposure.host,
    port,
    mode: exposure.mode,
    backend,
    startedAt: new Date().toISOString(),
  });

  printStartupInfo(exposure, token, port);
  line("Open that address on your phone and enter the setup token.");
  line("It stays paired across restarts. `prime-agent-mobile stop` ends it.");
  return 0;
}

async function status(options: Pick<Options, "demo">): Promise<number> {
  const config = loadConfig(baseEnv(options));
  const resolved = await resolveStatus(config.gatewayStatePath);
  if (!resolved.state) {
    line("Not running.");
    line("Start it with `prime-agent-mobile start`.");
    return 1;
  }
  if (!resolved.running) {
    line(`Not running. A previous gateway at ${resolved.state.url} exited without cleaning up.`);
    await clearGatewayState(config.gatewayStatePath);
    return 1;
  }
  line(`Running at ${resolved.state.url}`);
  line(`  pid     ${resolved.state.pid}`);
  line(`  mode    ${resolved.state.mode}`);
  line(`  backend ${resolved.state.backend}`);
  line(`  bound   ${resolved.state.host}:${resolved.state.port}`);
  line(`  since   ${resolved.state.startedAt}`);
  return 0;
}

/** Polls until the pid is actually gone, rather than assuming a signal worked. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    // The negative pid targets the process group `detached` created, so a
    // gateway that spawned helpers does not leave them behind.
    process.kill(-pid, name);
  } catch {
    try { process.kill(pid, name); } catch { /* already gone */ }
  }
}

async function stop(options: Pick<Options, "demo">): Promise<number> {
  const config = loadConfig(baseEnv(options));
  const resolved = await resolveStatus(config.gatewayStatePath);
  if (!resolved.state) {
    line("Not running.");
    return 1;
  }
  if (resolved.running) {
    signal(resolved.state.pid, "SIGTERM");
    // `rebuild` stops and immediately restarts on the same port: returning as
    // soon as SIGTERM is sent, rather than once the process is actually gone,
    // is how that restart lost a race against its own dying predecessor and
    // saw EADDRINUSE. Escalate once, so a stuck process cannot wedge it
    // forever, but only after giving a graceful exit a real chance.
    let exited = await waitForExit(resolved.state.pid, 5_000);
    if (!exited) {
      signal(resolved.state.pid, "SIGKILL");
      exited = await waitForExit(resolved.state.pid, 2_000);
    }
    if (!exited) {
      line(`Sent SIGKILL to pid ${resolved.state.pid}, but it is still alive. Not clearing its state.`);
      return 1;
    }
    line(`Stopped the gateway at ${resolved.state.url}.`);
  } else {
    line("It had already exited.");
  }
  await clearGatewayState(config.gatewayStatePath);
  return 0;
}

async function token(options: Options): Promise<number> {
  const config = loadConfig(baseEnv(options));
  const value = options.rotate
    ? await rotatePairingToken(config.pairingTokenPath)
    : await loadOrCreatePairingToken(config.pairingTokenPath);
  line(value);
  if (options.rotate) {
    line();
    line("Rotated. Devices already paired keep working; new ones need this token.");
    line("Restart the gateway for it to take effect.");
  }
  return 0;
}

/**
 * Installs the /webui slash command globally, so it exists in every Prime
 * Agent session rather than only inside this checkout.
 */
async function installCommand(): Promise<number> {
  const source = path.join(projectRoot, "extensions", "webui.ts");
  if (!await exists(source)) {
    line(`Could not find ${source}.`);
    return 1;
  }
  const target = path.join(homedir(), ".prime", "agent", "extensions");
  await mkdir(target, { recursive: true });
  const destination = path.join(target, "webui.ts");
  await copyFile(source, destination);
  line(`Installed /webui to ${destination}`);
  line();
  line("`/webui` reports where the UI is served, which is the address to verify");
  line("changes against. See docs/modifying-the-ui.md.");
  line();
  line("Start a new Prime Agent session and run `/webui`.");
  line("It reports where the web UI is, and starts it if it is not running.");
  return 0;
}

/**
 * Rebuilds and makes the result live at the address people are already using.
 *
 * Restarting a running gateway is the point, not a convenience. A rebuild
 * alone updates `dist/`, which a reload picks up, but leaves a changed server
 * running its old code — so "the change is live" would be true of one half of
 * the app and false of the other, which is worse than either.
 */
async function rebuild(options: Pick<Options, "demo">): Promise<number> {
  const config = loadConfig(baseEnv(options));
  const before = await resolveStatus(config.gatewayStatePath);
  if (!await safeRebuild()) return 1;

  if (!before.running || !before.state) {
    line();
    line("Rebuilt. The gateway is not running; `prime-agent-mobile start` will serve it.");
    return 0;
  }

  line();
  line("Rebuilt. Restarting the gateway so the change is actually live...");
  await stop({ demo: before.state.backend === "demo" });
  const restarted = await start({
    command: "start",
    mode: before.state.mode as ExposureMode,
    port: before.state.port,
    demo: before.state.backend === "demo",
    foreground: false,
    rotate: false,
  });
  if (restarted !== 0) return restarted;
  line();
  line(`Verify the change at ${before.state.url} — that address, not another one.`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    line(error instanceof Error ? error.message : String(error));
    return 1;
  }
  switch (options.command) {
    case "start": return start(options);
    case "status": return status(options);
    case "stop": return stop(options);
    case "token": return token(options);
    case "install-command": return installCommand();
    case "rebuild": return rebuild(options);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stdout.write(HELP);
      return 1;
  }
}

/**
 * Whether this module is the program being run, rather than a library import.
 *
 * Two things make the obvious comparison wrong, and both are the normal case
 * rather than an edge case.
 *
 * `process.argv[1]` is the path as it was typed. `import.meta.url` is the
 * RESOLVED module URL, with symlinks followed. Every npm `bin` is a symlink
 * from the global bin directory to the package's entry file, so installing
 * this CLI under its own name — the only way anyone actually runs it, and what
 * the /webui extension shells out to — made the two disagree and the guard
 * false. The command printed nothing and exited 0, for every subcommand,
 * including `--help`. Only `node dist-server/cli/index.js` ever ran.
 *
 * And building the URL by pasting the path after `file://` leaves whatever
 * needs escaping unescaped, so a checkout in a directory with a space in its
 * name failed the comparison too. `pathToFileURL` is what encodes that the
 * same way `import.meta.url` already is.
 *
 * Exported so this is covered by a test rather than only by running it.
 */
export function isProgramEntry(
  entry: string | undefined,
  moduleUrl: string,
  resolve: (target: string) => string = realpathSync,
): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === moduleUrl;
  } catch {
    // An argv[1] that cannot be resolved is not this file.
    return false;
  }
}

// Only when run as a program, so the tests can import the pure parts.
if (isProgramEntry(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    line(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
