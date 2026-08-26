import { describe, expect, it } from "vitest";
import { localHostname, parseArguments } from "./index.js";

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
