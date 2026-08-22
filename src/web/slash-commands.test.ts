import { describe, expect, it } from "vitest";
import {
  completeSessionSlashCommand,
  matchingSessionSlashCommands,
  parseSessionSlashCommandInput,
  SESSION_SLASH_COMMANDS,
} from "./slash-commands";

describe("mobile session slash commands", () => {
  it("exposes only commands executed by the headless Prime session", () => {
    expect(SESSION_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "compact",
      "refine",
      "goal",
      "autonomous",
    ]);
  });

  it("matches an unfinished command without treating arguments as commands", () => {
    expect(matchingSessionSlashCommands("/")).toHaveLength(4);
    expect(matchingSessionSlashCommands("/go").map((command) => command.name)).toEqual(["goal"]);
    expect(matchingSessionSlashCommands("/GO").map((command) => command.name)).toEqual(["goal"]);
    expect(matchingSessionSlashCommands("/goal status")).toEqual([]);
    expect(matchingSessionSlashCommands("hello /goal")).toEqual([]);
  });

  it("parses only supported single-line commands", () => {
    expect(parseSessionSlashCommandInput("/goal status")).toEqual({ name: "goal", args: "status" });
    expect(parseSessionSlashCommandInput("/model gpt")).toBeNull();
    expect(parseSessionSlashCommandInput("/goal\nstatus")).toBeNull();
    expect(parseSessionSlashCommandInput(" /goal status")).toBeNull();
  });

  it("completes a selected command with room for its optional argument", () => {
    const goal = SESSION_SLASH_COMMANDS.find((command) => command.name === "goal");
    expect(goal && completeSessionSlashCommand(goal)).toBe("/goal ");
  });
});
