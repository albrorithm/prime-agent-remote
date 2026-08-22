import { describe, expect, it } from "vitest";
import type { SlashCommandCatalog } from "../protocol";
import {
  FALLBACK_SLASH_COMMAND_CATALOG,
  formatSlashCommandResult,
  matchingSlashCommandSuggestions,
  parseSlashCommandInput,
} from "./slash-commands";

const catalog: SlashCommandCatalog = {
  agentId: "agent-1",
  agentRevision: 3,
  partial: false,
  commands: [
    ...FALLBACK_SLASH_COMMAND_CATALOG.commands,
    {
      name: "model",
      description: "Show or select model",
      argumentHint: "[provider/model]",
      source: "adapter",
      availability: "available",
      takesArguments: true,
      options: [
        { value: "openai/example", label: "Example", current: true },
        { value: "anthropic/other", label: "Other" },
      ],
    },
    {
      name: "deploy",
      description: "Extension command",
      source: "extension",
      availability: "experimental",
      takesArguments: true,
    },
  ],
};

describe("slash command suggestions", () => {
  it("matches command prefixes and keeps detected entries visible", () => {
    expect(matchingSlashCommandSuggestions("/go", catalog).map((item) => item.command.name)).toEqual(["goal"]);
    expect(matchingSlashCommandSuggestions("/dep", catalog)[0]?.command.availability).toBe("experimental");
    expect(matchingSlashCommandSuggestions("hello", catalog)).toEqual([]);
  });

  it("suggests safe catalog options for adapter arguments", () => {
    const suggestions = matchingSlashCommandSuggestions("/model ex", catalog);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ completion: "/model openai/example", description: "Current" });
  });
});

describe("slash command parsing", () => {
  it("parses available executable commands", () => {
    expect(parseSlashCommandInput("/goal  ship mobile  ", catalog)).toMatchObject({ name: "goal", args: "ship mobile" });
    expect(parseSlashCommandInput("/model openai/example", catalog)).toMatchObject({ name: "model", args: "openai/example" });
  });

  it("accepts cataloged experimental commands and rejects unknown or multiline commands", () => {
    expect(parseSlashCommandInput("/deploy production", catalog)).toMatchObject({ name: "deploy", args: "production" });
    expect(parseSlashCommandInput("/settings", catalog)).toBeNull();
    expect(parseSlashCommandInput("/goal status\n/model example", catalog)).toBeNull();
  });
});

describe("typed slash command result formatting", () => {
  it("uses browser-owned labels", () => {
    expect(formatSlashCommandResult({ kind: "model", provider: "openai", modelId: "example" })).toBe("Model: openai/example");
    expect(formatSlashCommandResult({ kind: "experimental_accepted", source: "extension" }))
      .toBe("Extension command accepted.");
    expect(formatSlashCommandResult({ kind: "heartbeat", status: "paused", schedule: "every 5m", deliveryMode: "follow_up" }))
      .toBe("Heartbeat: paused; every 5m; follow-up");
  });
});
