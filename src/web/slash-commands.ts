import { SESSION_SLASH_COMMAND_NAMES, type SessionSlashCommandName } from "../protocol";

export interface SessionSlashCommandOption {
  name: SessionSlashCommandName;
  description: string;
  argumentHint: string;
}

const COMMAND_METADATA: Record<SessionSlashCommandName, Omit<SessionSlashCommandOption, "name">> = {
  compact: {
    description: "Compact session context",
    argumentHint: "[instructions]",
  },
  refine: {
    description: "Refine continual harness",
    argumentHint: "[--global] [instructions]",
  },
  goal: {
    description: "Manage persistent goal",
    argumentHint: "[status|pause|resume|clear|objective]",
  },
  autonomous: {
    description: "Manage autonomous mode",
    argumentHint: "[status|on|off]",
  },
};

export const SESSION_SLASH_COMMANDS: readonly SessionSlashCommandOption[] = SESSION_SLASH_COMMAND_NAMES.map((name) => ({
  name,
  ...COMMAND_METADATA[name],
}));

export function matchingSessionSlashCommands(draft: string): readonly SessionSlashCommandOption[] {
  const match = /^\/([^\s/]*)$/.exec(draft);
  if (!match) return [];
  const query = match[1].toLowerCase();
  return SESSION_SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

export interface ParsedSessionSlashCommand {
  name: SessionSlashCommandName;
  args: string;
}

export function parseSessionSlashCommandInput(value: string): ParsedSessionSlashCommand | null {
  if (/[\r\n\u2028\u2029]/u.test(value)) return null;
  const match = /^\/(\S+)(?:[ \t]+(.*))?$/.exec(value);
  if (!match || !SESSION_SLASH_COMMAND_NAMES.includes(match[1] as SessionSlashCommandName)) return null;
  return { name: match[1] as SessionSlashCommandName, args: (match[2] ?? "").trim() };
}

export function completeSessionSlashCommand(command: SessionSlashCommandOption): string {
  return `/${command.name} `;
}
