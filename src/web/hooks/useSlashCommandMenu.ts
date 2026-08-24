import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  commandEntry,
  FALLBACK_SLASH_COMMAND_CATALOG,
  matchingSlashCommandSuggestions,
  parseSlashCommandInput,
  type SlashCommandSuggestion,
} from "../slash-commands";
import type { SlashCommandCatalog, SlashCommandCatalogEntry } from "../../protocol";

export interface SlashCommandMenu {
  slashCatalog: SlashCommandCatalog;
  slashCatalogReady: boolean;
  setSlashCatalog: (catalog: SlashCommandCatalog) => void;
  commandDraft: boolean;
  draftCommandEntry: SlashCommandCatalogEntry | undefined;
  experimentalCommandDraft: boolean;
  slashCommands: readonly SlashCommandSuggestion[];
  selectableSlashIndexes: number[];
  slashMenuOpen: boolean;
  activeSlashCommandIndex: number;
  activeSlashCommand: SlashCommandSuggestion | undefined;
  selectSlashCommand: (suggestion: SlashCommandSuggestion) => void;
  startSlashCommand: () => void;
  /** Handles the slash-menu-specific keys (arrow cycling, Tab-to-complete, Enter-to-select, Escape-to-dismiss). Returns true if it handled the event, so the caller's own Enter-to-submit fallback should not run. */
  handleTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export interface SlashCommandMenuDeps {
  id: string;
  draft: string;
  canSend: boolean;
  optionsOpen: boolean;
  sending: boolean;
  loadSlashCommands?: (agentId: string) => Promise<SlashCommandCatalog>;
  setDrafts: (update: (current: Record<string, string>) => Record<string, string>) => void;
  setAttachmentStatus: (status: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  closeOptions: (restoreFocus: boolean) => void;
}

export function useSlashCommandMenu({
  id,
  draft,
  canSend,
  optionsOpen,
  sending,
  loadSlashCommands,
  setDrafts,
  setAttachmentStatus,
  textareaRef,
  closeOptions,
}: SlashCommandMenuDeps): SlashCommandMenu {
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const [dismissedSlashDraft, setDismissedSlashDraft] = useState("");
  const [slashCatalog, setSlashCatalog] = useState(FALLBACK_SLASH_COMMAND_CATALOG);
  const [slashCatalogReady, setSlashCatalogReady] = useState(false);
  const activeAgentIdRef = useRef(id);
  activeAgentIdRef.current = id;

  useEffect(() => {
    setSlashCommandIndex(0);
    setDismissedSlashDraft("");
  }, [id]);

  useEffect(() => {
    let current = true;
    setSlashCatalog(FALLBACK_SLASH_COMMAND_CATALOG);
    setSlashCatalogReady(false);
    if (!id || !canSend) return () => { current = false; };
    if (typeof loadSlashCommands !== "function") {
      setSlashCatalogReady(true);
      return () => { current = false; };
    }
    void loadSlashCommands(id).then((catalog) => {
      if (!current || activeAgentIdRef.current !== id || catalog.agentId !== id) return;
      setSlashCatalog(catalog);
      setSlashCatalogReady(true);
    }).catch(() => {
      if (!current || activeAgentIdRef.current !== id) return;
      setSlashCatalogReady(false);
    });
    return () => { current = false; };
  }, [id, canSend, loadSlashCommands]);

  useEffect(() => {
    setSlashCommandIndex(0);
  }, [draft]);

  const commandDraft = draft.trimStart().startsWith("/");
  const draftCommandEntry = commandDraft ? commandEntry(draft.trim(), slashCatalog) : undefined;
  const experimentalCommandDraft = draftCommandEntry?.availability === "experimental";
  const slashCommands = matchingSlashCommandSuggestions(draft, slashCatalog);
  const selectableSlashIndexes = slashCatalogReady ? slashCommands.map((_, index) => index) : [];
  const slashMenuOpen = slashCommands.length > 0
    && dismissedSlashDraft !== draft
    && !optionsOpen
    && !sending
    && canSend;
  const activeSlashCommandIndex = selectableSlashIndexes.includes(slashCommandIndex)
    ? slashCommandIndex
    : selectableSlashIndexes[0] ?? 0;
  const activeSlashCommand = slashCommands[activeSlashCommandIndex];

  function selectSlashCommand(suggestion: SlashCommandSuggestion) {
    if (!slashCatalogReady || suggestion.command.availability === "unavailable") {
      setAttachmentStatus("This command was detected but is unavailable in the mobile UI.");
      return;
    }
    setDrafts((current) => ({ ...current, [id]: suggestion.completion }));
    setAttachmentStatus("");
    setSlashCommandIndex(0);
    setDismissedSlashDraft("");
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function startSlashCommand() {
    setDrafts((current) => ({ ...current, [id]: current[id]?.trim() ? current[id] : "/" }));
    closeOptions(false);
    setDismissedSlashDraft("");
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.key === "Escape" && slashMenuOpen) {
      event.preventDefault();
      setDismissedSlashDraft(draft);
      return true;
    }
    if (slashMenuOpen && activeSlashCommand && selectableSlashIndexes.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const position = Math.max(0, selectableSlashIndexes.indexOf(activeSlashCommandIndex));
        const next = (position + direction + selectableSlashIndexes.length) % selectableSlashIndexes.length;
        setSlashCommandIndex(selectableSlashIndexes[next]);
        return true;
      }
      if (event.key === "Tab" && activeSlashCommand.command.availability !== "unavailable") {
        event.preventDefault();
        selectSlashCommand(activeSlashCommand);
        return true;
      }
      const exactCommand = activeSlashCommand.argumentValue === undefined
        && draft === `/${activeSlashCommand.command.name}`;
      if (event.key === "Enter" && !event.shiftKey && !exactCommand) {
        event.preventDefault();
        selectSlashCommand(activeSlashCommand);
        return true;
      }
    }
    return false;
  }

  return {
    slashCatalog,
    slashCatalogReady,
    setSlashCatalog,
    commandDraft,
    draftCommandEntry,
    experimentalCommandDraft,
    slashCommands,
    selectableSlashIndexes,
    slashMenuOpen,
    activeSlashCommandIndex,
    activeSlashCommand,
    selectSlashCommand,
    startSlashCommand,
    handleTextareaKeyDown,
  };
}

export { experimentalCommandNoticeFor as experimentalCommandNotice };

function experimentalCommandNoticeFor(command: SlashCommandSuggestion["command"]): string {
  return command.source === "extension"
    ? "Experimental extension command. May run local extension code."
    : "Experimental command. Sends a model prompt.";
}
