import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GatewayState,
  GATEWAY_ENTRY_MARKER,
  clearGatewayState,
  isGatewayProcess,
  isProcessAlive,
  readGatewayState,
  resolveStatus,
  writeGatewayState,
} from "./state.js";

let directory: string;
let filePath: string;

const sample: GatewayState = {
  pid: 4242,
  url: "https://host.tailnet.ts.net",
  host: "127.0.0.1",
  port: 8787,
  mode: "tailscale",
  backend: "prime",
  startedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gateway-state-"));
  filePath = path.join(directory, "gateway.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("gateway state file", () => {
  it("round-trips", async () => {
    await writeGatewayState(filePath, sample);
    await expect(readGatewayState(filePath)).resolves.toEqual(sample);
  });

  it("remembers that this launcher published the Tailscale mapping", async () => {
    await writeGatewayState(filePath, { ...sample, serveManaged: true });
    await expect(readGatewayState(filePath)).resolves.toMatchObject({ serveManaged: true });
  });

  // Every state file written before the launcher published anything lacks the
  // field, and reading one must not report the gateway as absent.
  it("reads a state file that predates the field", async () => {
    await writeGatewayState(filePath, sample);
    const state = await readGatewayState(filePath);
    expect(state).not.toBeNull();
    expect(state?.serveManaged).toBeUndefined();
  });

  // Read back by `devices --revoke` and `rebuild` so an internal restart does
  // not silently republish Tailscale Serve for a `--no-serve` gateway.
  it("remembers that this launcher was started with --no-serve", async () => {
    await writeGatewayState(filePath, { ...sample, noServe: true });
    await expect(readGatewayState(filePath)).resolves.toMatchObject({ noServe: true });
  });

  it("reads a state file that predates noServe as absent, not false", async () => {
    await writeGatewayState(filePath, sample);
    const state = await readGatewayState(filePath);
    expect(state).not.toBeNull();
    expect(state?.noServe).toBeUndefined();
  });

  it("writes 0600, since it names a port someone may reach", async () => {
    await writeGatewayState(filePath, sample);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("returns null for an absent file rather than throwing", async () => {
    await expect(readGatewayState(filePath)).resolves.toBeNull();
  });

  it("returns null for unparseable or incomplete content", async () => {
    await writeFile(filePath, "{ not json");
    await expect(readGatewayState(filePath)).resolves.toBeNull();
    await writeFile(filePath, JSON.stringify({ pid: 1 }));
    await expect(readGatewayState(filePath)).resolves.toBeNull();
  });

  it("rejects a nonsense pid instead of trusting it", async () => {
    await writeFile(filePath, JSON.stringify({ ...sample, pid: -1 }));
    await expect(readGatewayState(filePath)).resolves.toBeNull();
  });

  it("clears without complaining about an absent file", async () => {
    await expect(clearGatewayState(filePath)).resolves.toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("reports this process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports a pid that cannot be signalled as dead", () => {
    expect(isProcessAlive(4242, () => { throw new Error("ESRCH"); })).toBe(false);
  });
});

describe("resolveStatus", () => {
  it("reports not running when there is no state at all", async () => {
    await expect(resolveStatus(filePath)).resolves.toEqual({ running: false, state: null, stale: false });
  });

  it("treats a state file whose process is gone as stale, not as running", async () => {
    await writeGatewayState(filePath, sample);
    const status = await resolveStatus(filePath, () => false);
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    // Kept, so the caller can say what used to be there.
    expect(status.state).toEqual(sample);
  });

  it("reports running only when the pid answers", async () => {
    await writeGatewayState(filePath, sample);
    const status = await resolveStatus(filePath, () => true);
    expect(status).toEqual({ running: true, state: sample, stale: false });
  });
});

describe("isGatewayProcess", () => {
  // The pid-reuse edge: `stop` signals the process GROUP and escalates to
  // SIGKILL, so acting on a recycled pid force-kills a bystander.
  it("recognises our own gateway from its argv", () => {
    const command = "/opt/homebrew/bin/node /Users/someone/app/dist-server/server/index.js";
    expect(isGatewayProcess(1234, GATEWAY_ENTRY_MARKER, () => command)).toBe(true);
  });

  it("rejects an unrelated process that inherited the pid", () => {
    for (const command of [
      "/usr/sbin/cupsd -l",
      "node /Users/someone/other-project/dist-server/server/other.js",
      "/opt/homebrew/bin/node /Users/someone/app/dist-server/cli/index.js status",
    ]) {
      expect(isGatewayProcess(1234, GATEWAY_ENTRY_MARKER, () => command)).toBe(false);
    }
  });

  // Refusing to stop a gateway that IS running is its own failure, so an
  // unreadable `ps` abstains rather than declaring the gateway gone.
  it("abstains when the process list cannot be read", () => {
    expect(isGatewayProcess(1234, GATEWAY_ENTRY_MARKER, () => null)).toBe(true);
    expect(isGatewayProcess(1234, GATEWAY_ENTRY_MARKER, () => "")).toBe(true);
  });

  it("treats a recycled pid as not running, so stop leaves it alone", async () => {
    const file = path.join(directory, "recycled.json");
    await writeGatewayState(file, {
      pid: 4321, url: "http://127.0.0.1:8787", host: "127.0.0.1", port: 8787,
      mode: "loopback", backend: "demo", startedAt: new Date(0).toISOString(),
    });
    const resolved = await resolveStatus(file, () => true, () => false);
    expect(resolved.running).toBe(false);
    expect(resolved.stale).toBe(true);
    expect(resolved.state?.pid).toBe(4321);
  });
});
