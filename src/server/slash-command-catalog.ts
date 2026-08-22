import {
  DIRECT_SLASH_COMMAND_NAMES,
  SESSION_SLASH_COMMAND_NAMES,
  type DirectSlashCommandName,
  type SlashCommandCatalogEntry,
  type SlashCommandOption,
} from "../protocol.js";

const METADATA: Record<string, Pick<SlashCommandCatalogEntry, "description" | "argumentHint" | "source" | "takesArguments">> = {
  compact: { description: "Compact session context", argumentHint: "[instructions]", source: "session", takesArguments: true },
  refine: { description: "Refine continual harness", argumentHint: "[--global] [instructions]", source: "session", takesArguments: true },
  goal: { description: "Manage persistent goal", argumentHint: "[status|pause|resume|clear|objective]", source: "session", takesArguments: true },
  autonomous: { description: "Manage autonomous mode", argumentHint: "[status|on|off]", source: "session", takesArguments: true },
  model: { description: "Show or select the session model", argumentHint: "[provider/model]", source: "adapter", takesArguments: true },
  effort: { description: "Show or select the thinking level", argumentHint: "[level]", source: "adapter", takesArguments: true },
  name: { description: "Show or set the session name", argumentHint: "[name]", source: "adapter", takesArguments: true },
  context: { description: "Show token, cost, and context usage", source: "adapter", takesArguments: false },
  heartbeat: {
    description: "Show or manage the persistent heartbeat",
    argumentHint: "[status|pause|resume|stop|every <duration> <instruction>]",
    source: "adapter",
    takesArguments: true,
  },
};

export interface BuiltinCatalogOptions {
  sessionCommandsAvailable?: boolean;
  supportedDirectCommands: ReadonlySet<DirectSlashCommandName>;
  modelOptions?: SlashCommandOption[];
  effortOptions?: SlashCommandOption[];
  heartbeatOptions?: SlashCommandOption[];
}

export function builtinSlashCommandEntries(options: BuiltinCatalogOptions): SlashCommandCatalogEntry[] {
  return [...SESSION_SLASH_COMMAND_NAMES, ...DIRECT_SLASH_COMMAND_NAMES].map((name) => ({
    name,
    ...METADATA[name],
    availability: (SESSION_SLASH_COMMAND_NAMES.includes(name as typeof SESSION_SLASH_COMMAND_NAMES[number])
      ? options.sessionCommandsAvailable !== false
      : options.supportedDirectCommands.has(name as DirectSlashCommandName))
      ? "available" as const
      : "unavailable" as const,
    ...((SESSION_SLASH_COMMAND_NAMES.includes(name as typeof SESSION_SLASH_COMMAND_NAMES[number])
      ? options.sessionCommandsAvailable === false
      : !options.supportedDirectCommands.has(name as DirectSlashCommandName))
      ? { unavailableReason: options.sessionCommandsAvailable === false ? "inactive_agent" as const : "adapter_missing" as const }
      : {}),
    ...(name === "model" && options.modelOptions?.length ? { options: options.modelOptions } : {}),
    ...(name === "effort" && options.effortOptions?.length ? { options: options.effortOptions } : {}),
    ...(name === "heartbeat" && options.heartbeatOptions?.length ? { options: options.heartbeatOptions } : {}),
  }));
}

interface DetectedPrimeCommand {
  name?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

const SAFE_COMMAND_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const DETECTED_SOURCES = new Set(["extension", "prompt", "skill"]);

export function detectedSlashCommandEntries(
  values: readonly DetectedPrimeCommand[],
  reservedNames: ReadonlySet<string>,
): SlashCommandCatalogEntry[] {
  const entries: SlashCommandCatalogEntry[] = [];
  const seen = new Set([...reservedNames].map((name) => name.toLowerCase()));
  for (const value of values) {
    if (entries.length >= 100 || typeof value.name !== "string" || !SAFE_COMMAND_NAME.test(value.name)) continue;
    const foldedName = value.name.toLowerCase();
    if (typeof value.source !== "string" || !DETECTED_SOURCES.has(value.source) || seen.has(foldedName)) continue;
    seen.add(foldedName);
    const source = value.source as "extension" | "prompt" | "skill";
    entries.push({
      name: value.name,
      description: `${source[0]?.toUpperCase()}${source.slice(1)} command`,
      source,
      availability: "experimental",
      takesArguments: true,
    });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export type ParsedHeartbeatArgs =
  | { type: "status" }
  | { type: "pause" | "resume" | "clear" }
  | { type: "set"; schedule: string; instruction: string; deliveryMode?: "steer" | "follow_up" };

const HEARTBEAT_DURATION = /^\d+(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i;

export function parseHeartbeatArgs(input: string): ParsedHeartbeatArgs | null {
  const text = input.trim();
  if (!text || text === "status") return { type: "status" };
  if (text === "pause" || text === "resume") return { type: text };
  if (text === "clear" || text === "stop") return { type: "clear" };

  const tokens = text.split(/\s+/);
  let deliveryMode: "steer" | "follow_up" | undefined;
  const remaining: string[] = [];
  for (const token of tokens) {
    if (token === "--steer" || token === "--follow-up") {
      if (deliveryMode) return null;
      deliveryMode = token === "--steer" ? "steer" : "follow_up";
    } else {
      remaining.push(token);
    }
  }

  let schedule = "every 5m";
  if (remaining[0] === "every" || remaining[0] === "--every") {
    const duration = remaining[1];
    if (!duration || !HEARTBEAT_DURATION.test(duration)) return null;
    schedule = `every ${duration}`;
    remaining.splice(0, 2);
  }
  const instruction = remaining.join(" ").trim();
  if (!instruction) return null;
  return { type: "set", schedule, instruction, ...(deliveryMode ? { deliveryMode } : {}) };
}
