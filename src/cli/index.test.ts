import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../server/device-store.js";
import { PushSubscriptionStore } from "../server/push-store.js";
import type { GatewayState } from "./state.js";
import { restartOptions, applyRevocation, connectableHost, gatewayOrigin, isProgramEntry, localHostname, parseArguments, readCliCheck, waitForOurGateway } from "./index.js";

/* Every npm `bin` is a symlink, so this is the ordinary case, not an edge one:
   installed under its own name the CLI used to print nothing and exit 0 for
   every subcommand, `--help` included, because argv[1] kept the symlink path
   while import.meta.url had already resolved it. /webui shells out to that
   name, so it was dead too. */
describe("isProgramEntry", () => {
  const moduleUrl = "file:///opt/pkg/dist-server/cli/index.js";
  const realpath = (target: string) =>
    target === "/opt/homebrew/bin/prime-agent-remote" ? "/opt/pkg/dist-server/cli/index.js" : target;

  it("recognises the file run directly", () => {
    expect(isProgramEntry("/opt/pkg/dist-server/cli/index.js", moduleUrl, realpath)).toBe(true);
  });

  it("recognises the file run through an installed bin symlink", () => {
    expect(isProgramEntry("/opt/homebrew/bin/prime-agent-remote", moduleUrl, realpath)).toBe(true);
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

  // Number() alone reads "0x10", "1e2", and "-5" as integers; none of them is
  // a port anyone typed on purpose, so digits-only matches config.ts's
  // parseInteger.
  it("refuses a port that Number() would accept but nobody typed on purpose", () => {
    expect(() => parseArguments(["start", "--port", "0x10"])).toThrow(/--port/u);
    expect(() => parseArguments(["start", "--port", "1e2"])).toThrow(/--port/u);
    expect(() => parseArguments(["start", "--port", "-5"])).toThrow(/--port/u);
    expect(() => parseArguments(["start", "--port", "3.5"])).toThrow(/--port/u);
  });

  // Silent last-wins meant `start --tailscale --loopback` bound loopback-only
  // while claiming (and behaving like) a tailnet-published run, or the other
  // way around, depending on flag order nobody was paying attention to.
  it("refuses a second exposure flag instead of letting the last one win", () => {
    expect(() => parseArguments(["start", "--tailscale", "--loopback"])).toThrow(/mutually exclusive/u);
    expect(() => parseArguments(["start", "--loopback", "--lan"])).toThrow(/mutually exclusive/u);
    expect(() => parseArguments(["start", "--tailscale", "--tailscale"])).toThrow(/mutually exclusive/u);
  });

  it("reads the standalone switches", () => {
    const options = parseArguments(["start", "--demo", "--foreground"]);
    expect(options.demo).toBe(true);
    expect(options.foreground).toBe(true);
    expect(parseArguments(["token", "--rotate"]).rotate).toBe(true);
  });

  // Publishing over Tailscale is the default in tailscale mode, so the flag
  // that matters is the one that declines it.
  it("leaves Tailscale alone only when asked to", () => {
    expect(parseArguments(["start"]).noServe).toBe(false);
    expect(parseArguments(["start", "--no-serve"]).noServe).toBe(true);
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
   shells out to a bare `prime-agent-remote`, so a checkout that was never
   linked gets a clean "Installed /webui" and then a failure inside a Prime
   Agent session, where nothing points back at the cause. */
describe("readCliCheck", () => {
  it("passes a CLI that answers", () => {
    expect(readCliCheck({ stdout: "prime-agent-remote — a phone-sized web UI\n" })).toBe("ok");
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
    expect(await applyRevocation(storePath, phone.device.id)).toEqual({ kind: "revoked", id: phone.device.id, pushDropped: 0 });
    expect(await remaining()).toEqual(["iPad"]);
  });

  it("reports an id that is not there rather than claiming a revocation", async () => {
    await pair("iPhone");
    expect(await applyRevocation(storePath, "not-a-device")).toEqual({ kind: "unknown", id: "not-a-device", pushDropped: 0 });
    expect(await remaining()).toEqual(["iPhone"]);
  });

  it("leaves no retry that can overwrite the gateway after a failed CLI revocation", async () => {
    const [phone] = await pair("phone");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await chmod(directory, 0o500);
      await expect(applyRevocation(storePath, phone.device.id)).rejects.toThrow();
      await chmod(directory, 0o700);
      const restarted = new DeviceStore(storePath);
      await restarted.load();
      await restarted.issue("new phone");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(await remaining()).toEqual(["phone", "new phone"]);
    } finally {
      await chmod(directory, 0o700);
      quiet.mockRestore();
    }
  });

  it("counts what `all` actually removed", async () => {
    await pair("iPhone", "iPad", "Android");
    expect(await applyRevocation(storePath, "all")).toEqual({ kind: "revoked-all", count: 3, pushDropped: 0 });
    expect(await remaining()).toEqual([]);
  });

  it("says zero rather than failing when there is nothing paired", async () => {
    expect(await applyRevocation(storePath, "all")).toEqual({ kind: "revoked-all", count: 0, pushDropped: 0 });
  });

  /* The offline path docs/security.md names for a phone you no longer hold. No
     session is live, so only the device binding can reach the push record. */
  describe("with a push store", () => {
    const pushStorePath = () => join(directory, "push-subscriptions.json");

    async function subscribe(...devices: (string | undefined)[]) {
      const store = new PushSubscriptionStore(pushStorePath());
      await store.load();
      for (const [index, deviceId] of devices.entries()) {
        await store.upsert({
          endpoint: `https://push.example.test/${index}`,
          p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU",
          auth: "3v0fHqQhH3xQ1r6mB3dOsg",
          sessionId: "session-that-died-with-the-process",
          deviceId,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }
    }

    async function endpoints() {
      const store = new PushSubscriptionStore(pushStorePath());
      await store.load();
      return store.list().map((record) => record.endpoint);
    }

    // An unreadable store loads as empty in the gateway, deliberately. Here it
    // would read as "nothing to drop" and the revocation would be reported as
    // applied over a file that still wakes the phone.
    it("refuses to revoke anything when the push store cannot be read", async () => {
      const [phone] = await pair("iPhone");
      await mkdir(pushStorePath());
      await expect(applyRevocation(storePath, phone.device.id, pushStorePath())).rejects.toThrow(/push subscription store/);
      expect(await remaining()).toEqual(["iPhone"]);
    });

    it("drops push records by device, none for an unknown id, and every one on `all`", async () => {
      const [phone, tablet] = await pair("iPhone", "iPad");
      // The third record is from before subscriptions carried a device id; the
      // fourth is what a revoke that wrote the device store and then failed on
      // the push store leaves behind.
      await subscribe(phone.device.id, tablet.device.id, undefined, "ghost");

      expect(await applyRevocation(storePath, "not-a-device", pushStorePath())).toMatchObject({ kind: "unknown", pushDropped: 0 });
      expect(await endpoints()).toHaveLength(4);

      expect(await applyRevocation(storePath, "ghost", pushStorePath())).toMatchObject({ kind: "unknown", pushDropped: 1 });
      expect(await endpoints()).toHaveLength(3);

      expect(await applyRevocation(storePath, phone.device.id, pushStorePath())).toMatchObject({ kind: "revoked", pushDropped: 1 });
      expect(await endpoints()).toEqual(["https://push.example.test/1", "https://push.example.test/2"]);

      expect(await applyRevocation(storePath, "all", pushStorePath())).toMatchObject({ kind: "revoked-all", count: 1, pushDropped: 2 });
      expect(await endpoints()).toEqual([]);
    });
  });
});

describe("restartOptions", () => {
  const state: GatewayState = {
    pid: 4242,
    url: "https://host.tailnet.ts.net",
    host: "127.0.0.1",
    port: 9001,
    mode: "tailscale",
    backend: "prime",
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  it("carries --no-serve forward when the running gateway was started with it", () => {
    expect(restartOptions({ ...state, noServe: true }).noServe).toBe(true);
  });

  it("defaults to false for a state written before the field existed", () => {
    expect(restartOptions(state).noServe).toBe(false);
  });

  it("carries the port, mode, and backend forward unchanged", () => {
    const options = restartOptions({ ...state, backend: "demo" });
    expect(options.port).toBe(9001);
    expect(options.mode).toBe("tailscale");
    expect(options.demo).toBe(true);
    expect(options.command).toBe("start");
    expect(options.foreground).toBe(false);
    expect(options.rotate).toBe(false);
    expect(options.qr).toBe(false);
  });
});
