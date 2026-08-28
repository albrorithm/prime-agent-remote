/**
 * Talking to the `tailscale` binary.
 *
 * Two things live here: finding the tailnet name (which decides whether
 * `--tailscale` is even available), and publishing the gateway over Tailscale
 * Serve. They are together because they have to agree on what "tailscale"
 * means — a machine where the CLI is the macOS app bundle and not on PATH
 * would otherwise detect a tailnet and then fail to publish to it.
 *
 * Everything takes an injected runner. There is no tailscale binary in CI, or
 * in most containers, and a module that can only be tested on a tailnet is a
 * module that is not tested.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The command, then the place macOS puts it when it is not on PATH. */
export const TAILSCALE_BINARIES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
] as const;

/** Serve terminates TLS here. Not configurable: the app's URL has no port in it. */
export const SERVE_PORT = 443;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type TailscaleRunner = (args: readonly string[]) => Promise<CommandResult>;

export class TailscaleCommandError extends Error {
  constructor(message: string, readonly stderr: string = "") {
    super(message);
  }
}

/**
 * Runs the first candidate binary that exists, and reports the last failure
 * if none do.
 *
 * A command that ran and exited non-zero is a different answer from a command
 * that is not installed, and only the first is worth showing anyone: the
 * second is the ordinary state of a machine without Tailscale.
 */
export function systemRunner(timeoutMs = 10_000): TailscaleRunner {
  return async (args) => {
    let lastError: unknown;
    for (const binary of TAILSCALE_BINARIES) {
      try {
        return await execFileAsync(binary, [...args], { timeout: timeoutMs });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        // ENOENT means this candidate is not installed; anything else means it
        // ran and had something to say, which is the answer we want to keep.
        if (code === "ENOENT") {
          lastError ??= error;
          continue;
        }
        throw new TailscaleCommandError(
          error instanceof Error ? error.message : String(error),
          String((error as { stderr?: unknown }).stderr ?? ""),
        );
      }
    }
    throw new TailscaleCommandError("tailscale is not installed", "");
  };
}

/**
 * Auth keys and OAuth secrets appear in Tailscale's own error output, and this
 * CLI prints that output when publishing fails. A secret that reaches a
 * terminal reaches a scrollback buffer, a screen recording, and an issue
 * report pasted in good faith.
 */
export function redactSecrets(text: string): string {
  return text.replace(/\b(tskey-[a-z]+-)[A-Za-z0-9-]+/gu, "$1REDACTED");
}

export function serveArguments(localPort: number): string[] {
  return ["serve", "--bg", `--https=${SERVE_PORT}`, `http://127.0.0.1:${localPort}`];
}

export function serveOffArguments(): string[] {
  return ["serve", `--https=${SERVE_PORT}`, "off"];
}

/** What the equivalent manual command looks like, for when we cannot run it. */
export function serveCommandLine(localPort: number): string {
  return `tailscale ${serveArguments(localPort).join(" ")}`;
}

export async function tailscaleDnsName(run: TailscaleRunner = systemRunner()): Promise<string | undefined> {
  try {
    const { stdout } = await run(["status", "--json"]);
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    return status.Self?.DNSName?.replace(/\.$/u, "") || undefined;
  } catch {
    // Not installed here, or not running.
    return undefined;
  }
}

/**
 * What is already published on the HTTPS port we want.
 *
 * `taken` is the case that matters. Running `serve` against a port someone
 * else's mapping owns does not fail — it replaces it, silently, and the
 * service that was there stops answering. Rewriting a user's machine
 * configuration is not something a convenience gets to do, so a taken port
 * ends in printed instructions rather than a takeover.
 */
export type ServeState = "ours" | "taken" | "free" | "unknown";

export function readServeState(statusJson: string, localPort: number): ServeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return "unknown";
  }
  if (parsed == null || typeof parsed !== "object") return "unknown";
  const web = (parsed as { Web?: unknown }).Web;
  if (web == null) return "free";
  if (typeof web !== "object") return "unknown";

  const target = `http://127.0.0.1:${localPort}`;
  let sawPort = false;
  for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
    if (!hostPort.endsWith(`:${SERVE_PORT}`)) continue;
    sawPort = true;
    const handlers = (entry as { Handlers?: unknown })?.Handlers;
    if (handlers == null || typeof handlers !== "object") continue;
    for (const handler of Object.values(handlers as Record<string, unknown>)) {
      const proxy = (handler as { Proxy?: unknown })?.Proxy;
      if (typeof proxy === "string" && proxy.replace(/\/$/u, "") === target) return "ours";
    }
  }
  return sawPort ? "taken" : "free";
}

export interface PublishOutcome {
  /** Whether this call created the mapping, and so owns taking it down. */
  published: boolean;
  state: ServeState;
  /** Said out loud by the caller. Empty when there is nothing worth saying. */
  message: string;
}

/**
 * Publishes the gateway over Serve unless something already holds the port.
 *
 * Never throws. A gateway that is running and reachable on loopback is a
 * success even when the convenience around it failed, and a start that aborts
 * because `serve` would not run is strictly worse than the manual step this
 * replaces.
 */
export async function publishServe(localPort: number, run: TailscaleRunner): Promise<PublishOutcome> {
  let state: ServeState;
  try {
    const { stdout } = await run(["serve", "status", "--json"]);
    state = readServeState(stdout, localPort);
  } catch {
    // An older tailscale without `serve status`, or one that would not answer.
    // Publishing blind could replace a mapping we were unable to read.
    state = "unknown";
  }

  if (state === "ours") {
    return { published: false, state, message: "Tailscale is already serving it." };
  }
  if (state === "taken" || state === "unknown") {
    const reason = state === "taken"
      ? `Something else already answers on Tailscale's port ${SERVE_PORT}, and replacing it is not this command's call.`
      : "Could not read the current `tailscale serve` configuration, so it was left alone.";
    return {
      published: false,
      state,
      message: `${reason}\nPublish it yourself with:\n  ${serveCommandLine(localPort)}`,
    };
  }

  try {
    await run(serveArguments(localPort));
    return { published: true, state, message: `Published over Tailscale: ${serveCommandLine(localPort)}` };
  } catch (error) {
    const stderr = error instanceof TailscaleCommandError ? error.stderr : "";
    const detail = redactSecrets((stderr || (error instanceof Error ? error.message : String(error))).trim());
    return {
      published: false,
      state,
      message: `Could not publish it over Tailscale${detail ? `: ${detail}` : "."}\nRun it yourself with:\n  ${serveCommandLine(localPort)}`,
    };
  }
}

/** Takes down a mapping this CLI published. Silent about a failure to. */
export async function unpublishServe(run: TailscaleRunner): Promise<boolean> {
  try {
    await run(serveOffArguments());
    return true;
  } catch {
    return false;
  }
}
