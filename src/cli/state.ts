import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * What a running gateway is, written where another process can read it.
 *
 * The CLI, and the Prime Agent command that wraps it, both need to answer
 * "is it up, and what URL is it on?" without guessing. A postmortem in a
 * comparable project records an agent editing a UI, failing to find the
 * process serving it, starting a second server on another port and validating
 * that one instead. A file the launcher writes is what stops that.
 */
export interface GatewayState {
  pid: number;
  url: string;
  host: string;
  port: number;
  mode: string;
  backend: string;
  startedAt: string;
  /**
   * True when this launcher published the Tailscale Serve mapping, and so is
   * the one allowed to take it down. Absent in states written before the
   * launcher published anything, and absent whenever the mapping was already
   * there — a mapping we did not create is not ours to remove.
   */
  serveManaged?: boolean;
}

const MAX_STATE_BYTES = 8 * 1024;

function isState(value: unknown): value is GatewayState {
  if (value == null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.pid === "number" && Number.isInteger(state.pid) && state.pid > 0
    && typeof state.url === "string" && state.url.length > 0
    && typeof state.host === "string"
    && typeof state.port === "number"
    && typeof state.mode === "string"
    && typeof state.backend === "string"
    && typeof state.startedAt === "string";
}

export async function readGatewayState(filePath: string): Promise<GatewayState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.length > MAX_STATE_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeGatewayState(filePath: string, state: GatewayState): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function clearGatewayState(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}

/**
 * Signal 0 asks "may I signal this process?" without sending anything. It
 * answers "is it alive?" for a process this user owns, which is the only case
 * that matters: the launcher wrote the file, so the gateway is the same user.
 */
export function isProcessAlive(pid: number, kill: (pid: number, signal: number) => void = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedStatus {
  running: boolean;
  state: GatewayState | null;
  /** True when a state file described a process that is no longer there. */
  stale: boolean;
}

/** The gateway's entry path, as it appears in the launched process's argv. */
export const GATEWAY_ENTRY_MARKER = path.join("dist-server", "server", "index.js");

function readProcessCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether this pid is still *our* gateway rather than an unrelated process
 * that inherited the number.
 *
 * `kill(pid, 0)` only answers "does some process hold this number", and pids
 * get reused. `stop` signals the process *group* and now escalates to SIGKILL,
 * so acting on a recycled pid does not merely fail — it force-kills whatever
 * the operating system handed the number to next. Checking argv is the same
 * question a `pkill` pattern should have been asked before it was run: what
 * else matches this?
 *
 * A hung gateway still carries the right argv, so this does not cost the
 * ability to kill one that has stopped answering. If `ps` cannot be read at
 * all the check abstains rather than declaring the gateway gone, because
 * refusing to stop a gateway that is genuinely running is its own failure.
 */
export function isGatewayProcess(
  pid: number,
  marker: string = GATEWAY_ENTRY_MARKER,
  read: (pid: number) => string | null = readProcessCommand,
): boolean {
  const command = read(pid);
  if (command === null || command === "") return true;
  return command.includes(marker);
}

/**
 * A state file outlives a crash, so its presence is not evidence. The pid is
 * checked before anything reports the gateway as running — and so is what the
 * pid actually belongs to.
 */
export async function resolveStatus(
  filePath: string,
  alive: (pid: number) => boolean = (pid) => isProcessAlive(pid),
  isOurs: (pid: number) => boolean = (pid) => isGatewayProcess(pid),
): Promise<ResolvedStatus> {
  const state = await readGatewayState(filePath);
  if (!state) return { running: false, state: null, stale: false };
  if (!alive(state.pid) || !isOurs(state.pid)) return { running: false, state, stale: true };
  return { running: true, state, stale: false };
}
