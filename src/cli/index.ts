#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { connect } from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../server/config.js";
import { loadOrCreatePairingToken, rotatePairingToken } from "../server/pairing-token.js";
import { resolvePrimeModule } from "../server/prime-module.js";
import { type ExposureMode, defaultExposureMode, resolveExposure } from "./exposure.js";
import { clearGatewayState, resolveStatus, writeGatewayState } from "./state.js";

const execFileAsync = promisify(execFile);

/**
 * Waits until something actually accepts a connection on the port.
 *
 * A spawned process is not a serving one. Reporting "running" from a live pid
 * alone is how a launcher ends up telling someone to open a URL that refuses
 * the connection, and how an agent concludes a change is live when nothing is
 * listening. The check is a real connection to the real port.
 */
async function waitForListening(host: string, port: number, timeoutMs = 15_000): Promise<boolean> {
  // A wildcard bind is not a connectable address; loopback is inside it.
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: target, port });
      const settle = (value: boolean): void => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      socket.setTimeout(1_000, () => settle(false));
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `prime-agent-mobile — a phone-sized web UI for Prime Agent

Usage:
  prime-agent-mobile start [options]   Start the gateway in the background
  prime-agent-mobile status            Say whether it is running, and where
  prime-agent-mobile stop              Stop it
  prime-agent-mobile token [--rotate]  Print the setup token
  prime-agent-mobile help

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

async function ensureBuilt(): Promise<void> {
  const built = await exists(path.join(projectRoot, "dist", "index.html"))
    && await exists(path.join(projectRoot, "dist-server", "server", "index.js"));
  if (built) return;
  process.stdout.write("Building the app (first run only)...\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm run build exited ${code}`))));
  });
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function start(options: Options): Promise<number> {
  // Read without forcing production: the paths do not depend on it, and
  // production validation would reject an origin allowlist this function has
  // not computed yet. The gateway child gets NODE_ENV=production below.
  const config = loadConfig(process.env);
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
  }

  const mode = options.mode ?? defaultExposureMode({ tailscale: Boolean(tailscaleHost) });
  const exposure = resolveExposure({ mode, port, tailscaleHost, localHostname: localHostname() });

  await ensureBuilt();

  const token = await loadOrCreatePairingToken(config.pairingTokenPath);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
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
  line("Open that address on your phone and enter the setup token.");
  line("It stays paired across restarts. `prime-agent-mobile stop` ends it.");
  return 0;
}

async function status(): Promise<number> {
  const config = loadConfig(process.env);
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

async function stop(): Promise<number> {
  const config = loadConfig(process.env);
  const resolved = await resolveStatus(config.gatewayStatePath);
  if (!resolved.state) {
    line("Not running.");
    return 1;
  }
  if (resolved.running) {
    try {
      // The negative pid targets the process group `detached` created, so a
      // gateway that spawned helpers does not leave them behind.
      process.kill(-resolved.state.pid, "SIGTERM");
    } catch {
      try {
        process.kill(resolved.state.pid, "SIGTERM");
      } catch {
        line("The gateway could not be signalled; it may already be gone.");
      }
    }
    line(`Stopped the gateway at ${resolved.state.url}.`);
  } else {
    line("It had already exited.");
  }
  await clearGatewayState(config.gatewayStatePath);
  return 0;
}

async function token(options: Options): Promise<number> {
  const config = loadConfig(process.env);
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
    case "status": return status();
    case "stop": return stop();
    case "token": return token(options);
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

// Only when run as a program, so the tests can import the pure parts.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    line(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
