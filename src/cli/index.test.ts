import { describe, expect, it } from "vitest";
import { isProgramEntry, localHostname, parseArguments } from "./index.js";

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
