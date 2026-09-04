#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, constants, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildPairingUrl } from "../protocol.js";
import { type GatewayConfig, loadConfig } from "../server/config.js";
import { DeviceStore } from "../server/device-store.js";
import { loadOrCreatePairingToken, rotatePairingToken } from "../server/pairing-token.js";
import { resolvePrimeModule } from "../server/prime-module.js";
import { PushSubscriptionStore } from "../server/push-store.js";
import { demoConfigDir, demoEnv } from "./demo-stores.js";
import { type ExposureMode, defaultExposureMode, resolveExposure, type Exposure } from "./exposure.js";
import { isPrimeWebGatewayResponse } from "./gateway-identity.js";
import { QrTooLongError, encodeQr, renderQr } from "./qr.js";
import { clearGatewayState, isProcessAlive, resolveStatus, writeGatewayState } from "./state.js";
import {
  type PublishOutcome,
  publishServe,
  serveCommandLine,
  serveOffArguments,
  systemRunner,
  tailscaleDnsName,
  unpublishServe,
} from "./tailscale.js";

const execFileAsync = promisify(execFile);

/**
 * Whether the thing answering on `host:port` is a gateway of ours at all, as
 * opposed to something else that merely accepted the connection.
 *
 * `GET /api/v1/bootstrap` unauthenticated always 401s with a fixed body; see
 * `gateway-identity.ts` for why that is a safe thing to check without a
 * dedicated health endpoint. Note the limit: it identifies the software, not
 * the instance. Two gateways answer this identically, so nothing here can tell
 * ours from somebody else's.
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

/** A wildcard bind is not a connectable address; loopback is inside it. */
export function connectableHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function gatewayOrigin(host: string, port: number): string {
  return `http://${connectableHost(host)}:${port}`;
}

/**
 * Waits for a freshly spawned gateway to come up, and says which way it ended.
 *
 * A spawned process is not a serving one, and a serving process is not
 * necessarily this one. `probe` can only answer "is a gateway serving this
 * port" — never "is it mine" — so a probe on its own reports success when the
 * port belongs to somebody else's gateway and this child died on EADDRINUSE.
 * That is how `start --demo` against an occupied port printed a demo token for
 * a URL serving the real backend, and how `stop` was then left holding a pid
 * that had never served anything.
 *
 * `isAlive` supplies the missing half. It is still not proof of identity —
 * only `start`'s refusal to spawn onto a port that already answers gives that
 * — but a probe that succeeds counts only while the process it was started
 * for is still running, and a child that dies is reported as died rather than
 * waited out for the full timeout.
 */
export async function waitForOurGateway(options: {
  probe: () => Promise<boolean>;
  isAlive: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"listening" | "died" | "timeout"> {
  const { probe, isAlive } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await probe()) return isAlive() ? "listening" : "died";
    if (!isAlive()) return "died";
    await sleep(intervalMs);
  }
  return "timeout";
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `prime-agent-remote — a phone-sized web UI for Prime Agent

Usage:
  prime-agent-remote start [options]     Start the gateway in the background
  prime-agent-remote status [--demo]     Say whether it is running, and where
  prime-agent-remote stop [--demo]       Stop it
  prime-agent-remote token [--rotate] [--qr] [--demo]   Print the setup token
  prime-agent-remote devices [--revoke <id|all>] [--demo]  List or revoke paired devices
  prime-agent-remote rebuild [--demo]    Rebuild the UI and make it live
  prime-agent-remote install-command     Add /webui to Prime Agent
  prime-agent-remote help

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
  --no-serve      Do not publish over Tailscale; print the command instead
`;

interface Options {
  command: string;
  mode?: ExposureMode;
  port?: number;
  demo: boolean;
  foreground: boolean;
  rotate: boolean;
  /** Leave `tailscale serve` alone, and say what to run by hand. */
  noServe: boolean;
  /** Print the pairing link as a scannable code. */
  qr: boolean;
  /** A device id, or "all". Absent means list rather than revoke. */
  revoke?: string;
}

export function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    command: argv[0] ?? "help",
    demo: false,
    foreground: false,
    rotate: false,
    noServe: false,
    qr: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tailscale" || argument === "--loopback" || argument === "--lan") {
      options.mode = argument.slice(2) as ExposureMode;
    } else if (argument === "--demo") options.demo = true;
    else if (argument === "--foreground") options.foreground = true;
    else if (argument === "--no-serve") options.noServe = true;
    else if (argument === "--qr") options.qr = true;
    else if (argument === "--rotate") options.rotate = true;
    else if (argument === "--revoke") {
      const value = argv[index + 1];
      // A bare --revoke would otherwise read as "revoke nothing" and exit 0,
      // which looks exactly like success.
      if (!value || value.startsWith("--")) throw new Error("--revoke needs a device id, or all");
      options.revoke = value;
      index += 1;
    }
    else if (argument === "--port") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value)) throw new Error(`--port needs a number, not ${argv[index + 1] ?? "nothing"}`);
      options.port = value;
      index += 1;
    } else throw new Error(`Unknown option ${argument}. Run \`prime-agent-remote help\`.`);
  }
  return options;
}

/** The mDNS name a phone on the same network can resolve. */
export function localHostname(raw = hostname()): string {
  const name = raw.replace(/\.$/u, "");
  return name.includes(".") ? name : `${name}.local`;
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

/**
 * `serve` is null when nothing tried to publish the mapping — `--no-serve`, or
 * a mode where Serve has no part to play. It carries its own account of what
 * happened otherwise, including the manual command when it declined to act.
 */
function printStartupInfo(
  exposure: Exposure,
  token: string,
  port: number,
  serve: PublishOutcome | null,
): void {
  line();
  line(`Running at ${exposure.url}`);
  line(`Setup token: ${token}`);
  line();
  if (exposure.mode === "tailscale") {
    if (serve) for (const text of serve.message.split("\n")) line(text);
    else {
      line("Tailscale still needs to publish it once:");
      line(`  ${serveCommandLine(port)}`);
    }
    line();
  }
  printPairingCode(exposure.url, token, exposure.mode !== "loopback");
  for (const warning of exposure.warnings) line(`Note: ${warning}`);
  if (exposure.warnings.length > 0) line();
}

function pairingHint(exposure: Exposure): string {
  return exposure.mode === "loopback"
    ? "Open that address and enter the setup token."
    : "Scan the code with the phone's camera, or open the address and type the token.";
}

/**
 * The pairing link as a scannable code.
 *
 * Typing a 43-character token into a phone is the worst step in setting this
 * up, and it is often two: iOS can give the installed app storage separate
 * from Safari's, so the same token gets typed again. A camera does it in one.
 *
 * Not printed for a loopback gateway. A phone cannot open that address, and
 * offering a code that cannot work is worse than saying nothing.
 */
function printPairingCode(url: string, token: string, reachable: boolean): void {
  if (!reachable) return;
  const link = buildPairingUrl(url, token);
  try {
    line("Scan this to pair a phone, or open the address and type the token:");
    line();
    // Colour only when a terminal will interpret it; see renderQr.
    line(renderQr(encodeQr(link), { color: process.stdout.isTTY === true && !process.env.NO_COLOR }));
    line();
  } catch (error) {
    // A tailnet name long enough to overflow the largest version this encodes
    // is possible, and is not a reason to fail a start.
    if (!(error instanceof QrTooLongError)) throw error;
    line(`Pairing link: ${link}`);
    line();
  }
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
    line("Use `prime-agent-remote stop` first, or `status` to see it.");
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
      line("Or start without it: `prime-agent-remote start --demo`.");
      return 1;
    }
  } else {
    line("  Backend: demo (no real agent is reachable)");
    line(`  Demo stores: ${demoConfigDir(process.env)} — kept separate from your real pairing token and devices`);
  }

  const mode = options.mode ?? defaultExposureMode({ tailscale: Boolean(tailscaleHost) });
  const exposure = resolveExposure({ mode, port, tailscaleHost, localHostname: localHostname() });

  // Refuse the port before spawning anything. A gateway cannot recognise
  // itself over HTTP (see `waitForOurGateway`), so once a second one is in
  // the picture every later check reads the first one's replies as proof that
  // our child came up — and we go on to print a URL, and a setup token, for
  // somebody else's gateway. The state file only knows about instances this
  // CLI started, so it cannot catch this on its own.
  if (await respondsAsGateway(gatewayOrigin(exposure.host, port))) {
    line();
    line(`Port ${port} already answers as a prime-agent-remote gateway, and it is not one this CLI started.`);
    line("Another checkout, a real gateway when you asked for --demo (both default to the");
    line("same port), or one left behind by a --foreground run that was killed.");
    line();
    line("Give this one its own port with `--port`, or stop the other one first.");
    return 1;
  }

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

  /* Publishing is a convenience wrapped around a gateway that is already
     correct without it, so it never decides whether the start succeeds. It can
     also decline — see publishServe — in which case it hands back the command
     to run by hand and printStartupInfo says so. */
  const serve = exposure.mode === "tailscale" && !options.noServe
    ? await publishServe(port, systemRunner())
    : null;

  if (options.foreground) {
    // The background path prints the URL and token once the gateway proves
    // it is listening; this one hands the terminal straight to the child, so
    // it has to say them first — and only here can it, since passing
    // PRIME_WEB_PAIRING_TOKEN explicitly (above) means the child's own
    // `generatedPairingToken` is false and it never prints the token itself.
    printStartupInfo(exposure, token, port, serve);
    line(pairingHint(exposure));
    line();
    const child = spawn(process.execPath, [entry], { cwd: projectRoot, env: environment, stdio: "inherit" });
    const code = await new Promise<number>((resolve) => child.on("exit", (exitCode) => resolve(exitCode ?? 0)));
    // No state file outlives a foreground run, so `stop` will never see this
    // mapping. Take down what this run put up, here, while we still know.
    if (serve?.published) await unpublishServe(systemRunner());
    return code;
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
  const pid = child.pid;
  if (!pid) {
    line("Could not start the gateway.");
    return 1;
  }

  const outcome = await waitForOurGateway({
    probe: () => respondsAsGateway(gatewayOrigin(exposure.host, port)),
    isAlive: () => isProcessAlive(pid),
  });
  if (outcome !== "listening") {
    line();
    if (outcome === "died") line(`The gateway (pid ${pid}) exited without serving port ${port}.`);
    else line(`The gateway started (pid ${pid}) but nothing is listening on port ${port}.`);
    line("Run `prime-agent-remote start --foreground` to see why.");
    signal(pid, "SIGTERM");
    return 1;
  }

  await writeGatewayState(config.gatewayStatePath, {
    pid,
    url: exposure.url,
    host: exposure.host,
    port,
    mode: exposure.mode,
    backend,
    startedAt: new Date().toISOString(),
    // Recorded only when this run created it, because that is exactly when
    // `stop` may take it down. A mapping someone else made outlives us.
    ...(serve?.published ? { serveManaged: true } : {}),
  });

  printStartupInfo(exposure, token, port, serve);
  line(pairingHint(exposure));
  line("It stays paired across restarts. `prime-agent-remote stop` ends it.");
  return 0;
}

async function status(options: Pick<Options, "demo">): Promise<number> {
  const config = loadConfig(baseEnv(options));
  const resolved = await resolveStatus(config.gatewayStatePath);
  if (!resolved.state) {
    line("Not running.");
    line("Start it with `prime-agent-remote start`.");
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
  if (resolved.state.serveManaged) {
    line(await unpublishServe(systemRunner())
      ? "Removed the Tailscale mapping this CLI published."
      : `Could not remove the Tailscale mapping. Take it down with:\n  tailscale ${serveOffArguments().join(" ")}`);
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
  if (options.qr) {
    // The address is the running gateway's, not something this command can
    // derive: it depends on the exposure mode that `start` chose.
    const resolved = await resolveStatus(config.gatewayStatePath);
    line();
    if (!resolved.running || !resolved.state) {
      line("Not running, so there is no address to pair with yet. Start it first.");
    } else if (resolved.state.mode === "loopback") {
      line(`Running on ${resolved.state.url}, which no other device can open.`);
      line("Start it with --tailscale (or --lan) to pair a phone.");
    } else {
      printPairingCode(resolved.state.url, value, true);
    }
  }
  if (options.rotate) {
    line();
    line("Rotated. Devices already paired keep working; new ones need this token.");
    line("Restart the gateway for it to take effect.");
  }
  return 0;
}

export type RevocationOutcome =
  | { kind: "revoked"; id: string; pushDropped: number }
  | { kind: "revoked-all"; count: number; pushDropped: number }
  | { kind: "unknown"; id: string; pushDropped: number };

/**
 * Applies a revocation to both stores on disk; the caller owns the printing.
 * The push record is the one that survives a restart, so skipping it would
 * leave the phone still being woken. `all` clears the push store outright:
 * records from before subscriptions carried a device id have nothing to match,
 * and "revoke all" means no device may be woken. Safe because the caller has
 * already stopped the gateway, as `revokeDevices` explains.
 */
export async function applyRevocation(
  storePath: string,
  revoke: string,
  pushStorePath?: string,
): Promise<RevocationOutcome> {
  const store = new DeviceStore(storePath);
  await store.load();

  const pushStore = pushStorePath ? new PushSubscriptionStore(pushStorePath) : undefined;
  await pushStore?.load();

  if (revoke === "all") {
    return { kind: "revoked-all", count: await store.revokeAll(), pushDropped: (await pushStore?.removeAll()) ?? 0 };
  }
  if (await store.revoke(revoke)) {
    return { kind: "revoked", id: revoke, pushDropped: (await pushStore?.removeDevice(revoke)) ?? 0 };
  }
  return { kind: "unknown", id: revoke, pushDropped: 0 };
}

/**
 * Paired devices, from the machine rather than the phone.
 *
 * Settings → Paired devices does this too, and does it better. This exists for
 * the case that one cannot serve: no device you still hold can sign in.
 */
async function devices(options: Options): Promise<number> {
  const config = loadConfig(baseEnv(options));

  if (options.revoke) return revokeDevices(config, options.revoke);

  const store = new DeviceStore(config.deviceStorePath);
  await store.load();
  const paired = store.list();
  if (!paired.length) {
    line("No paired devices. Open the address on a phone and enter the setup token.");
    return 0;
  }
  for (const device of paired) {
    line(`${device.id}  ${device.name}`);
    line(`  paired ${device.createdAt}, last used ${device.lastSeenAt}`);
  }
  line();
  line("Revoke one with --revoke <id>, or all of them with --revoke all.");
  return 0;
}

/**
 * Revokes, and makes the revocation true of the running gateway as well as of
 * the file.
 *
 * Writing to the device store while a gateway is up revokes nothing. The
 * gateway loads the store once at startup (`gateway.ts`) and blind-writes its
 * in-memory copy on every sighting, so the removed device goes on exchanging
 * its credential for new sessions, and the next `verify()` persists the stale
 * list and puts the record back in the file. This read as a delay for a while —
 * "takes effect on the next restart" — and was really a revocation that undid
 * itself, in the one path documented for a phone you no longer have.
 *
 * So the gateway is stopped around the write rather than after it. After it
 * still loses: a resume landing between the write and the stop resurrects the
 * record, and the restart then loads it back. Stopped first, there is no
 * process to race.
 *
 * `rebuild` makes the same trade for the same reason. The cost is that every
 * other device's sessions end too, which their device credentials silently
 * restore — that is what those credentials are for.
 */
async function revokeDevices(config: GatewayConfig, revoke: string): Promise<number> {
  const before = await resolveStatus(config.gatewayStatePath);
  const running = before.running && before.state ? before.state : null;

  if (running) {
    line(`Stopping the gateway at ${running.url}, so the revocation cannot be undone under it.`);
    if (await stop({ demo: running.backend === "demo" }) !== 0) {
      line();
      line("Nothing was revoked. A gateway still holding the store would have put the device back.");
      return 1;
    }
    line();
  }

  const restart = async (): Promise<number> => {
    line();
    line("Starting it again...");
    line();
    const restarted = await start({
      command: "start",
      mode: running!.mode as ExposureMode,
      port: running!.port,
      demo: running!.backend === "demo",
      foreground: false,
      rotate: false,
      noServe: false,
      qr: false,
    });
    if (restarted !== 0) {
      line();
      line("The revocation is applied, but the gateway did not come back up.");
      line("Start it again with `prime-agent-remote start`.");
    }
    return restarted;
  };

  let outcome: RevocationOutcome;
  try {
    outcome = await applyRevocation(config.deviceStorePath, revoke, config.webPushStorePath);
  } catch (error) {
    // The gateway was stopped for this write. A store that would not take it
    // is the caller's to report; it is not a reason to leave the gateway down.
    if (running) await restart();
    throw error;
  }
  if (outcome.kind === "revoked-all") {
    line(`Revoked ${outcome.count} device${outcome.count === 1 ? "" : "s"}. Every phone needs the setup token again.`);
  } else if (outcome.kind === "revoked") {
    line(`Revoked ${outcome.id}.`);
  } else {
    line(`No device with id ${outcome.id}.`);
  }
  // The half of a revocation an operator cannot otherwise see.
  if (outcome.pushDropped > 0) {
    const plural = outcome.pushDropped === 1 ? "" : "s";
    line(`Dropped ${outcome.pushDropped} push subscription${plural}. Those devices stop being woken.`);
  }

  if (!running) return outcome.kind === "unknown" ? 1 : 0;
  const restarted = await restart();
  if (restarted !== 0) return restarted;
  return outcome.kind === "unknown" ? 1 : 0;
}

/** The name `/webui` shells out to, and the name npm installs this under. */
export const CLI_NAME = "prime-agent-remote";

/**
 * What `/webui` will actually find when it shells out.
 *
 * The extension calls a bare `prime-agent-remote`, so copying the file into
 * ~/.prime proves nothing on its own — the command is only as good as the one
 * on PATH, and a checkout that was never linked has none. Reporting a clean
 * install in that case moves the failure to first use inside a Prime Agent
 * session, where the cause is no longer visible.
 *
 * Running `help` rather than merely locating a file also catches the npm 11
 * case: a git install whose `prepare` script was skipped leaves the bin entry
 * present but unbuilt, and every subcommand exits 0 having printed nothing.
 */
export function readCliCheck(result: { error?: NodeJS.ErrnoException; stdout?: string }): "ok" | "missing" | "silent" {
  if (result.error) return result.error.code === "ENOENT" ? "missing" : "silent";
  return (result.stdout ?? "").trim().length > 0 ? "ok" : "silent";
}

async function checkCliOnPath(): Promise<"ok" | "missing" | "silent"> {
  try {
    const { stdout } = await execFileAsync(CLI_NAME, ["help"], { timeout: 10_000 });
    return readCliCheck({ stdout });
  } catch (error) {
    return readCliCheck({ error: error as NodeJS.ErrnoException });
  }
}

/**
 * Installs the /webui slash command globally, so it exists in every Prime
 * Agent session rather than only inside this checkout.
 *
 * Deliberately a command someone runs, not something `npm install` does for
 * them: `prepare` fires for contributors and CI too, and writing into another
 * tool's config directory from a build script is not a side effect an install
 * should have. It would also install a command that cannot work yet, since
 * nothing has put the CLI on PATH by then.
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

  const cli = await checkCliOnPath();
  if (cli !== "ok") {
    line(`It will not work yet. \`/webui\` shells out to a bare \`${CLI_NAME}\`, and`);
    line(cli === "missing"
      ? "nothing on PATH answers to that name."
      : `\`${CLI_NAME} help\` prints nothing, which is a git install whose build was skipped.`);
    line();
    line("From this checkout: `npm link`. Then run `/webui` in a new session.");
    return 1;
  }

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
    line("Rebuilt. The gateway is not running; `prime-agent-remote start` will serve it.");
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
    noServe: false,
    qr: false,
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
    case "devices": return devices(options);
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
