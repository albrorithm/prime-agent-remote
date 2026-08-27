import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../server/device-store.js";
import { applyRevocation, connectableHost, gatewayOrigin, isProgramEntry, localHostname, parseArguments, readCliCheck, waitForOurGateway } from "./index.js";

/* Every npm `bin` is a symlink, so this is the ordinary case, not an edge one:
   installed under its own name the CLI used to print nothing and exit 0 for
   every subcommand, `--help` included, because argv[1] kept the symlink path
   while import.meta.url had already resolved it. /webui shells out to that
   name, so it was dead too. */
describe("isProgramEntry", () => {
  const moduleUrl = "file:///opt/pkg/dist-server/cli/index.js";
  const realpath = (target: string) =>
    target === "/opt/homebrew/bin/prime-agent-mobile" ? "/opt/pkg/dist-server/cli/index.js" : target;

  it("recognises the file run directly", () => {
    expect(isProgramEntry("/opt/pkg/dist-server/cli/index.js", moduleUrl, realpath)).toBe(true);
  });

  it("recognises the file run through an installed bin symlink", () => {
    expect(isProgramEntry("/opt/homebrew/bin/prime-agent-mobile", moduleUrl, realpath)).toBe(true);
  });

  it("rejects a different program", () => {
    expect(isProgramEntry("/opt/pkg/dist-server/server/index.js", moduleUrl, realpath)).toBe(false);
  });

  it("is false when imported as a library, with no entry at all", () => {
    expect(isProgramEntry(undefined, moduleUrl, realpath)).toBe(false);
  });

  it("is false rather than throwing when the entry cannot be resolved", () => {
    expect(isProgramEntry("/gone", moduleUrl, () => { throw new Error("ENOENT"); })).toBe(false);
  });

  // Pasting the path after `file://` leaves what needs escaping unescaped, so a
  // checkout in a directory with a space failed the comparison.
  it("matches a path that has to be percent-encoded", () => {
    const spaced = "file:///opt/my%20apps/dist-server/cli/index.js";
    expect(isProgramEntry("/opt/my apps/dist-server/cli/index.js", spaced, (t) => t)).toBe(true);
  });
});

describe("parseArguments", () => {
  it("defaults to help when given nothing", () => {
    expect(parseArguments([]).command).toBe("help");
  });

  it("reads each exposure flag", () => {
    expect(parseArguments(["start", "--tailscale"]).mode).toBe("tailscale");
    expect(parseArguments(["start", "--loopback"]).mode).toBe("loopback");
    expect(parseArguments(["start", "--lan"]).mode).toBe("lan");
  });

  it("leaves the mode unset so the launcher can choose", () => {
    expect(parseArguments(["start"]).mode).toBeUndefined();
  });

  it("reads a port", () => {
    expect(parseArguments(["start", "--port", "9000"]).port).toBe(9000);
  });

  it("refuses a port that is not a number instead of starting on a guess", () => {
    expect(() => parseArguments(["start", "--port", "http"])).toThrow(/--port/u);
    expect(() => parseArguments(["start", "--port"])).toThrow(/--port/u);
  });

  it("reads the standalone switches", () => {
    const options = parseArguments(["start", "--demo", "--foreground"]);
    expect(options.demo).toBe(true);
    expect(options.foreground).toBe(true);
    expect(parseArguments(["token", "--rotate"]).rotate).toBe(true);
  });

  it("reads a device to revoke, and refuses a bare --revoke", () => {
    expect(parseArguments(["devices"]).revoke).toBeUndefined();
    expect(parseArguments(["devices", "--revoke", "device-7"]).revoke).toBe("device-7");
    expect(parseArguments(["devices", "--revoke", "all"]).revoke).toBe("all");
    // A bare --revoke that parsed would revoke nothing and exit 0, which reads
    // exactly like having revoked something.
    expect(() => parseArguments(["devices", "--revoke"])).toThrow(/--revoke/u);
    expect(() => parseArguments(["devices", "--revoke", "--demo"])).toThrow(/--revoke/u);
  });

  it("rejects an unknown option rather than ignoring it", () => {
    expect(() => parseArguments(["start", "--publish-to-the-internet"])).toThrow(/Unknown option/u);
  });
});

describe("localHostname", () => {
  it("appends .local to a bare name so a phone can resolve it", () => {
    expect(localHostname("study")).toBe("study.local");
  });

  it("leaves an already-qualified name alone", () => {
    expect(localHostname("study.local")).toBe("study.local");
    expect(localHostname("host.tailnet.ts.net")).toBe("host.tailnet.ts.net");
  });

  it("strips a trailing dot", () => {
    expect(localHostname("study.local.")).toBe("study.local");
  });
});

describe("connectableHost", () => {
  it("turns a wildcard bind into an address something can actually connect to", () => {
    expect(connectableHost("0.0.0.0")).toBe("127.0.0.1");
    expect(connectableHost("::")).toBe("127.0.0.1");
  });

  it("leaves a real bind address alone", () => {
    expect(connectableHost("127.0.0.1")).toBe("127.0.0.1");
    expect(gatewayOrigin("0.0.0.0", 8787)).toBe("http://127.0.0.1:8787");
  });
});

/* The bug this exists for: `start --demo` on a port a real gateway already
   held printed a demo token and "Running at ...", because a probe cannot tell
   one gateway from another and the demo child had already died on EADDRINUSE.
   An already-paired phone opening that URL lands in real sessions with no
   token prompt in the way. */
describe("waitForOurGateway", () => {
  const clock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms: number) => { time += ms; } };
  };

  it("reports listening only when the process it waited for is still alive", async () => {
    const { now, sleep } = clock();
    await expect(waitForOurGateway({
      probe: async () => true,
      isAlive: () => true,
      now,
      sleep,
    })).resolves.toBe("listening");
  });

  it("calls a port that answers while our child is gone somebody else's gateway", async () => {
    const { now, sleep } = clock();
    await expect(waitForOurGateway({
      probe: async () => true,
      isAlive: () => false,
      now,
      sleep,
    })).resolves.toBe("died");
  });

  it("gives up as soon as the child dies rather than waiting out the timeout", async () => {
    const { now, sleep } = clock();
    let alive = true;
    let polls = 0;
    const outcome = await waitForOurGateway({
      probe: async () => { polls += 1; if (polls === 2) alive = false; return false; },
      isAlive: () => alive,
      now,
      sleep,
      timeoutMs: 15_000,
      intervalMs: 200,
    });
    expect(outcome).toBe("died");
    expect(polls).toBe(2);
    expect(now()).toBeLessThan(1_000);
  });

  it("waits out a slow but living start, then reports it", async () => {
    const { now, sleep } = clock();
    let polls = 0;
    await expect(waitForOurGateway({
      probe: async () => { polls += 1; return polls > 5; },
      isAlive: () => true,
      now,
      sleep,
      intervalMs: 200,
    })).resolves.toBe("listening");
  });

  it("times out when nothing ever answers and the process never dies", async () => {
    const { now, sleep } = clock();
    await expect(waitForOurGateway({
      probe: async () => false,
      isAlive: () => true,
      now,
      sleep,
      timeoutMs: 1_000,
      intervalMs: 200,
    })).resolves.toBe("timeout");
  });
});

/* `install-command` copying the file is the easy half. The command it installs
   shells out to a bare `prime-agent-mobile`, so a checkout that was never
   linked gets a clean "Installed /webui" and then a failure inside a Prime
   Agent session, where nothing points back at the cause. */
describe("readCliCheck", () => {
  it("passes a CLI that answers", () => {
    expect(readCliCheck({ stdout: "prime-agent-mobile — a phone-sized web UI\n" })).toBe("ok");
  });

  it("calls a name nothing on PATH answers to missing", () => {
    expect(readCliCheck({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) })).toBe("missing");
  });

  it("calls a bin that runs but prints nothing silent, not ok", () => {
    // npm 11 skipping a git dependency's prepare script: the bin exists,
    // exits 0, and has no build behind it.
    expect(readCliCheck({ stdout: "" })).toBe("silent");
    expect(readCliCheck({ stdout: "   \n" })).toBe("silent");
  });

  it("does not read a non-ENOENT failure as absence", () => {
    expect(readCliCheck({ error: Object.assign(new Error("EACCES"), { code: "EACCES" }) })).toBe("silent");
  });
});

describe("applyRevocation", () => {
  let storePath: string;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cli-revoke-"));
    storePath = join(directory, "devices.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function pair(...names: string[]) {
    const store = new DeviceStore(storePath);
    await store.load();
    const issued = [];
    for (const name of names) issued.push(await store.issue(name));
    return issued;
  }

  async function remaining() {
    const store = new DeviceStore(storePath);
    await store.load();
    return store.list().map((device) => device.name);
  }

  it("removes one device and leaves the others paired", async () => {
    const [phone] = await pair("iPhone", "iPad");
    expect(await applyRevocation(storePath, phone.device.id)).toEqual({ kind: "revoked", id: phone.device.id });
    expect(await remaining()).toEqual(["iPad"]);
  });

  it("reports an id that is not there rather than claiming a revocation", async () => {
    await pair("iPhone");
    expect(await applyRevocation(storePath, "not-a-device")).toEqual({ kind: "unknown", id: "not-a-device" });
    expect(await remaining()).toEqual(["iPhone"]);
  });

  it("counts what `all` actually removed", async () => {
    await pair("iPhone", "iPad", "Android");
    expect(await applyRevocation(storePath, "all")).toEqual({ kind: "revoked-all", count: 3 });
    expect(await remaining()).toEqual([]);
  });

  it("says zero rather than failing when there is nothing paired", async () => {
    expect(await applyRevocation(storePath, "all")).toEqual({ kind: "revoked-all", count: 0 });
  });
});
