import {
  SESSION_SLASH_COMMAND_NAMES,
  SESSION_SLASH_COMMAND_METADATA,
  type SlashCommandCatalog,
  type SlashCommandCatalogEntry,
  type SlashCommandResult,
} from "../protocol";

/**
 * What the composer suggests before the real catalog arrives.
 *
 * The descriptions come from protocol.ts rather than being restated here: this
 * stands in for the gateway's catalog for a moment, and a fallback that
 * described a command differently from the thing replacing it would be worse
 * than no fallback. Availability is added rather than shared — see the note on
 * SESSION_SLASH_COMMAND_METADATA.
 */
export const FALLBACK_SLASH_COMMAND_CATALOG: SlashCommandCatalog = {
  agentId: "",
  agentRevision: 0,
  partial: true,
  commands: SESSION_SLASH_COMMAND_NAMES.map((name) => ({
    name,
    ...SESSION_SLASH_COMMAND_METADATA[name],
    availability: "available" as const,
  })),
};

export interface SlashCommandSuggestion {
  key: string;
  command: SlashCommandCatalogEntry;
  display: string;
  description: string;
  completion: string;
  argumentValue?: string;
}

export function matchingSlashCommandSuggestions(
  draft: string,
  catalog: SlashCommandCatalog,
): readonly SlashCommandSuggestion[] {
  const commandMatch = /^\/([^\s/]*)$/.exec(draft);
  if (commandMatch) {
    const query = commandMatch[1].toLowerCase();
    return catalog.commands
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .sort((left, right) => {
        const rank = (availability: SlashCommandCatalogEntry["availability"]) =>
          availability === "available" ? 0 : availability === "experimental" ? 1 : 2;
        return rank(left.availability) - rank(right.availability);
      })
      .map((command) => ({
        key: `command:${command.name}`,
        command,
        display: `/${command.name}`,
        description: command.description,
        completion: `/${command.name}${command.takesArguments ? " " : ""}`,
      }));
  }

  const argumentMatch = /^\/(\S+)[ \t]+([^\r\n\u2028\u2029]*)$/.exec(draft);
  if (!argumentMatch) return [];
  const command = catalog.commands.find((item) => item.name === argumentMatch[1]);
  if (!command?.options?.length || command.availability === "unavailable") return [];
  const query = argumentMatch[2].trim().toLowerCase();
  return command.options
    .filter((option) => !query || option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query))
    .slice(0, 50)
    .map((option) => ({
      key: `argument:${command.name}:${option.value}`,
      command,
      display: `/${command.name} ${option.label}`,
      description: option.current ? "Current" : command.description,
      completion: `/${command.name} ${option.value}`,
      argumentValue: option.value,
    }));
}

export interface ParsedSlashCommand {
  name: string;
  args: string;
  entry: SlashCommandCatalogEntry;
}

export function parseSlashCommandInput(value: string, catalog: SlashCommandCatalog): ParsedSlashCommand | null {
  if (/[\r\n\u2028\u2029]/u.test(value)) return null;
  const match = /^\/(\S+)(?:[ 	]+(.*))?$/.exec(value);
  if (!match) return null;
  const entry = catalog.commands.find((command) => command.name === match[1]);
  if (!entry || entry.availability === "unavailable") return null;
  return { name: match[1], args: (match[2] ?? "").trim(), entry };
}

export function commandEntry(value: string, catalog: SlashCommandCatalog): SlashCommandCatalogEntry | undefined {
  const match = /^\/(\S+)/.exec(value);
  return match ? catalog.commands.find((command) => command.name === match[1]) : undefined;
}

export function formatSlashCommandResult(result: SlashCommandResult): string {
  switch (result.kind) {
    case "session_accepted":
      return "";
    case "experimental_accepted":
      return `${result.source[0].toUpperCase()}${result.source.slice(1)} command accepted.`;
    case "model":
      return result.provider && result.modelId ? `Model: ${result.provider}/${result.modelId}` : "No model selected.";
    case "effort":
      return result.level ? `Thinking level: ${result.level}` : "Current model does not support thinking.";
    case "name":
      return result.name ? `Session name: ${result.name}` : "This session has no name.";
    case "context_usage": {
      const parts = [
        result.contextTokens !== undefined && result.contextWindow !== undefined
          ? `Context: ${Math.trunc(result.contextTokens).toLocaleString()} / ${Math.trunc(result.contextWindow).toLocaleString()} tokens${result.percent !== undefined ? ` (${result.percent.toFixed(1)}%)` : ""}`
          : "Context usage unavailable",
        result.totalTokens !== undefined ? `session total: ${Math.trunc(result.totalTokens).toLocaleString()} tokens` : undefined,
        result.cost !== undefined ? `cost: $${result.cost.toFixed(4)}` : undefined,
      ].filter((part): part is string => Boolean(part));
      return parts.join("; ");
    }
    case "heartbeat":
      if (result.status === "none") return "No active heartbeat.";
      return [
        `Heartbeat: ${result.status}`,
        result.schedule,
        result.deliveryMode === "follow_up" ? "follow-up" : result.deliveryMode,
        result.nextRunAt ? `next ${result.nextRunAt}` : undefined,
      ].filter(Boolean).join("; ");
  }
}
