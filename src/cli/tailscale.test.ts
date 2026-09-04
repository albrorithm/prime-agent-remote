import { describe, expect, it } from "vitest";
import {
  SERVE_PORT,
  TailscaleCommandError,
  publishServe,
  readServeState,
  redactSecrets,
  serveArguments,
  serveOffArguments,
  tailscaleDnsName,
  unpublishServe,
  type CommandResult,
  type TailscaleRunner,
} from "./tailscale.js";

function runner(responses: Record<string, CommandResult | Error>): {
  run: TailscaleRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: TailscaleRunner = async (args) => {
    calls.push([...args]);
    const key = args.join(" ");
    const response = responses[key];
    if (response instanceof Error) throw response;
    if (!response) throw new TailscaleCommandError(`unexpected command: ${key}`);
    return response;
  };
  return { run, calls };
}

function serveStatus(entries: Record<string, string>): string {
  return JSON.stringify({
    Web: Object.fromEntries(
      Object.entries(entries).map(([hostPort, proxy]) => [hostPort, { Handlers: { "/": { Proxy: proxy } } }]),
    ),
  });
}

describe("serve command construction", () => {
  it("publishes loopback behind the HTTPS port, in the background", () => {
    expect(serveArguments(8787)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:8787"]);
  });

  // The port has to be named on the way down too, or `off` is ambiguous about
  // which mapping it means.
  it("names the same port when taking it down", () => {
    expect(serveOffArguments()).toEqual(["serve", "--https=443", "off"]);
  });
});

describe("readServeState", () => {
  it("recognises a mapping that already points at our port", () => {
    const status = serveStatus({ [`host.tailnet.ts.net:${SERVE_PORT}`]: "http://127.0.0.1:8787" });
    expect(readServeState(status, 8787)).toBe("ours");
  });

  it("tolerates the trailing slash Tailscale sometimes reports", () => {
    const status = serveStatus({ [`host.tailnet.ts.net:${SERVE_PORT}`]: "http://127.0.0.1:8787/" });
    expect(readServeState(status, 8787)).toBe("ours");
  });

  /* The case worth being careful about: `serve` against a port someone else's
     mapping owns replaces it rather than failing, and whatever was there stops
     answering. */
  it("reports a port held by something else as taken, not free", () => {
    const status = serveStatus({ [`host.tailnet.ts.net:${SERVE_PORT}`]: "http://127.0.0.1:3000" });
    expect(readServeState(status, 8787)).toBe("taken");
  });

  it("ignores mappings on other ports", () => {
    const status = serveStatus({ "host.tailnet.ts.net:8443": "http://127.0.0.1:3000" });
    expect(readServeState(status, 8787)).toBe("free");
  });

  it("treats an empty configuration as free", () => {
    expect(readServeState("{}", 8787)).toBe("free");
  });

  it("treats a node that has never had a serve config, which answers null, as free", () => {
    expect(readServeState("null", 8787)).toBe("free");
  });

  it("does not guess at output it cannot parse", () => {
    expect(readServeState("not json", 8787)).toBe("unknown");
    expect(readServeState('{"Web": 3}', 8787)).toBe("unknown");
  });
});

describe("redactSecrets", () => {
  it("keeps the shape of an auth key without its value", () => {
    expect(redactSecrets("permission denied for tskey-auth-k123CNTRL-secretvalue"))
      .toBe("permission denied for tskey-auth-REDACTED");
  });

  it("leaves ordinary output alone", () => {
    expect(redactSecrets("no such host")).toBe("no such host");
  });
});

describe("publishServe", () => {
  it("publishes when the port is free, and says it owns the mapping", async () => {
    const { run, calls } = runner({
      "serve status --json": { stdout: "{}", stderr: "" },
      "serve --bg --https=443 http://127.0.0.1:8787": { stdout: "", stderr: "" },
    });

    const outcome = await publishServe(8787, run);

    expect(outcome.published).toBe(true);
    expect(calls).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:8787"]);
  });

  it("does nothing when the mapping is already ours", async () => {
    const status = serveStatus({ [`host.tailnet.ts.net:${SERVE_PORT}`]: "http://127.0.0.1:8787" });
    const { run, calls } = runner({ "serve status --json": { stdout: status, stderr: "" } });

    const outcome = await publishServe(8787, run);

    expect(outcome.published).toBe(false);
    expect(outcome.message).toContain("already serving");
    expect(calls).toHaveLength(1);
  });

  it("refuses to take over a port something else holds, and says how to do it by hand", async () => {
    const status = serveStatus({ [`host.tailnet.ts.net:${SERVE_PORT}`]: "http://127.0.0.1:3000" });
    const { run, calls } = runner({ "serve status --json": { stdout: status, stderr: "" } });

    const outcome = await publishServe(8787, run);

    expect(outcome.published).toBe(false);
    expect(calls).toHaveLength(1);
    expect(outcome.message).toContain("tailscale serve --bg --https=443 http://127.0.0.1:8787");
  });

  // An older tailscale has no `serve status`. Publishing anyway could replace
  // a mapping we were not able to read.
  it("leaves a configuration it cannot read alone", async () => {
    const { run, calls } = runner({ "serve status --json": new TailscaleCommandError("unknown subcommand") });

    const outcome = await publishServe(8787, run);

    expect(outcome.published).toBe(false);
    expect(outcome.state).toBe("unknown");
    expect(calls).toHaveLength(1);
  });

  it("reports a failed publish with its reason redacted, rather than throwing", async () => {
    const { run } = runner({
      "serve status --json": { stdout: "{}", stderr: "" },
      "serve --bg --https=443 http://127.0.0.1:8787":
        new TailscaleCommandError("exit 1", "not logged in: tskey-auth-k123CNTRL-secretvalue"),
    });

    const outcome = await publishServe(8787, run);

    expect(outcome.published).toBe(false);
    expect(outcome.message).toContain("tskey-auth-REDACTED");
    expect(outcome.message).not.toContain("secretvalue");
  });
});

describe("unpublishServe", () => {
  it("takes the mapping down", async () => {
    const { run, calls } = runner({ "serve --https=443 off": { stdout: "", stderr: "" } });
    expect(await unpublishServe(run)).toBe(true);
    expect(calls).toEqual([["serve", "--https=443", "off"]]);
  });

  it("reports a failure instead of raising one into a stop that otherwise worked", async () => {
    const { run } = runner({ "serve --https=443 off": new TailscaleCommandError("no mapping") });
    expect(await unpublishServe(run)).toBe(false);
  });
});

describe("tailscaleDnsName", () => {
  it("reads the name and drops the trailing dot", async () => {
    const { run } = runner({
      "status --json": { stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }), stderr: "" },
    });
    expect(await tailscaleDnsName(run)).toBe("host.tailnet.ts.net");
  });

  it("is undefined when tailscale is not there, rather than an error", async () => {
    const { run } = runner({ "status --json": new TailscaleCommandError("not installed") });
    expect(await tailscaleDnsName(run)).toBeUndefined();
  });

  it("is undefined when the name is empty", async () => {
    const { run } = runner({ "status --json": { stdout: JSON.stringify({ Self: {} }), stderr: "" } });
    expect(await tailscaleDnsName(run)).toBeUndefined();
  });
});
