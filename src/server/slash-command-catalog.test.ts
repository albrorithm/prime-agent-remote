import { describe, expect, it } from "vitest";
import {
  builtinSlashCommandEntries,
  detectedSlashCommandEntries,
  parseHeartbeatArgs,
} from "./slash-command-catalog.js";

describe("slash command catalog projection", () => {
  it("marks only available explicit adapters as supported", () => {
    const entries = builtinSlashCommandEntries({
      supportedDirectCommands: new Set(["model", "context"]),
      modelOptions: [{ value: "openai/example", label: "Example", current: true }],
    });
    expect(entries.find((entry) => entry.name === "compact")?.availability).toBe("available");
    expect(entries.find((entry) => entry.name === "model")).toMatchObject({
      availability: "available",
      options: [{ value: "openai/example", current: true }],
    });
    expect(entries.find((entry) => entry.name === "effort")?.availability).toBe("unavailable");
  });

  it("keeps only bounded command names and strips daemon metadata", () => {
    const entries = detectedSlashCommandEntries([
      { name: "deploy", source: "extension", sourceInfo: { path: "/private/plugin.ts" }, description: "private" },
      { name: "skill:review", source: "skill" },
      { name: "deploy", source: "prompt" },
      { name: "../../escape", source: "extension" },
      { name: "hidden", source: "unknown" },
    ], new Set(["compact"]));
    expect(entries).toEqual([
      {
        name: "deploy",
        description: "Extension command",
        source: "extension",
        availability: "experimental",
        takesArguments: true,
      },
      {
        name: "skill:review",
        description: "Skill command",
        source: "skill",
        availability: "experimental",
        takesArguments: true,
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("private");
  });

  it("rejects bidi/control names, deduplicates case-insensitively, sorts, and caps detection", () => {
    const candidates = [
      { name: "Goal", source: "extension" },
      { name: "safe", source: "extension" },
      { name: "SAFE", source: "prompt" },
      { name: "bi\u202Edi", source: "skill" },
      { name: "line\nbreak", source: "extension" },
      ...Array.from({ length: 120 }, (_, index) => ({ name: `item-${String(index).padStart(3, "0")}`, source: "prompt" })),
    ];
    const entries = detectedSlashCommandEntries(candidates, new Set(["goal"]));
    expect(entries).toHaveLength(100);
    expect(entries.some((entry) => entry.name.toLowerCase() === "goal")).toBe(false);
    expect(entries.filter((entry) => entry.name.toLowerCase() === "safe")).toHaveLength(1);
    expect(entries.some((entry) => entry.name.includes("\u202E") || entry.name.includes("\n"))).toBe(false);
    expect(entries.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name).slice().sort());
  });
});

describe("heartbeat argument parsing", () => {
  it("parses status and management actions", () => {
    expect(parseHeartbeatArgs("")).toEqual({ type: "status" });
    expect(parseHeartbeatArgs("pause")).toEqual({ type: "pause" });
    expect(parseHeartbeatArgs("stop")).toEqual({ type: "clear" });
  });

  it("parses conservative set syntax", () => {
    expect(parseHeartbeatArgs("every 15m --follow-up Check the build")).toEqual({
      type: "set",
      schedule: "every 15m",
      instruction: "Check the build",
      deliveryMode: "follow_up",
    });
    expect(parseHeartbeatArgs("--steer Review status")).toEqual({
      type: "set",
      schedule: "every 5m",
      instruction: "Review status",
      deliveryMode: "steer",
    });
  });

  it("rejects incomplete or ambiguous syntax", () => {
    expect(parseHeartbeatArgs("every 5m")).toBeNull();
    expect(parseHeartbeatArgs("every tomorrow Check status")).toBeNull();
    expect(parseHeartbeatArgs("--steer --follow-up Check status")).toBeNull();
  });
});
