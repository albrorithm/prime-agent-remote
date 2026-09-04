import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandCatalog } from "../../protocol";
import { FALLBACK_SLASH_COMMAND_CATALOG } from "../slash-commands";
import { experimentalCommandNotice, useSlashCommandMenu, type SlashCommandMenuDeps } from "./useSlashCommandMenu";

const catalog: SlashCommandCatalog = {
  agentId: "agent-1",
  agentRevision: 1,
  partial: false,
  commands: [
    { name: "goal", description: "Manage persistent goal", argumentHint: "[objective]", source: "session", availability: "available", takesArguments: true },
    { name: "context", description: "Show context usage", source: "adapter", availability: "available", takesArguments: false },
    { name: "deploy", description: "Extension command", source: "extension", availability: "experimental", takesArguments: true },
    { name: "future", description: "Unavailable adapter command", source: "adapter", availability: "unavailable", unavailableReason: "adapter_missing", takesArguments: false },
  ],
};

function makeTextarea(): RefObject<HTMLTextAreaElement | null> {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  return { current: textarea };
}

function key(overrides: Partial<{ key: string; shiftKey: boolean }>) {
  return { key: "", shiftKey: false, preventDefault: () => {}, ...overrides } as unknown as Parameters<
    ReturnType<typeof useSlashCommandMenu>["handleTextareaKeyDown"]
  >[0];
}

function setup(overrides: Partial<SlashCommandMenuDeps> = {}) {
  const setDrafts = vi.fn();
  const setAttachmentStatus = vi.fn();
  const closeOptions = vi.fn();
  const textareaRef = makeTextarea();
  const defaultDeps: SlashCommandMenuDeps = {
    id: "agent-1",
    draft: "",
    canSend: true,
    optionsOpen: false,
    sending: false,
    loadSlashCommands: undefined,
    setDrafts,
    setAttachmentStatus,
    textareaRef,
    closeOptions,
    ...overrides,
  };
  const utils = renderHook((deps: SlashCommandMenuDeps) => useSlashCommandMenu(deps), { initialProps: defaultDeps });
  return { ...utils, setDrafts, setAttachmentStatus, closeOptions, textareaRef };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("useSlashCommandMenu catalog loading", () => {
  it("starts with the fallback catalog, not ready, while a real load is pending", () => {
    const loadSlashCommands = vi.fn().mockReturnValue(new Promise<SlashCommandCatalog>(() => {}));
    const { result } = setup({ loadSlashCommands });
    expect(result.current.slashCatalog).toBe(FALLBACK_SLASH_COMMAND_CATALOG);
    expect(result.current.slashCatalogReady).toBe(false);
  });

  it("loads and swaps in the resolved catalog for the active agent", async () => {
    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    const { result } = setup({ loadSlashCommands });
    await flushMicrotasks();
    expect(loadSlashCommands).toHaveBeenCalledWith("agent-1");
    expect(result.current.slashCatalog).toBe(catalog);
    expect(result.current.slashCatalogReady).toBe(true);
  });

  it("is ready immediately when no loadSlashCommands function is provided", () => {
    const { result } = setup({ loadSlashCommands: undefined });
    expect(result.current.slashCatalogReady).toBe(true);
    expect(result.current.slashCatalog).toBe(FALLBACK_SLASH_COMMAND_CATALOG);
  });

  it("does not load a catalog while canSend is false", async () => {
    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    const { result } = setup({ canSend: false, loadSlashCommands });
    await flushMicrotasks();
    expect(loadSlashCommands).not.toHaveBeenCalled();
    expect(result.current.slashCatalogReady).toBe(false);
  });

  it("ignores a resolution that no longer matches the active agent id", async () => {
    let resolve!: (value: SlashCommandCatalog) => void;
    const loadSlashCommands = vi.fn().mockReturnValue(new Promise<SlashCommandCatalog>((r) => { resolve = r; }));
    const { result, rerender } = setup({ loadSlashCommands });
    rerender({ id: "agent-2", draft: "", canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });

    await act(async () => {
      resolve(catalog);
      await Promise.resolve();
    });
    expect(result.current.slashCatalog).not.toBe(catalog);
    expect(result.current.slashCatalogReady).toBe(false);
  });

  it("marks the catalog not-ready when loading rejects", async () => {
    const loadSlashCommands = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = setup({ loadSlashCommands });
    await flushMicrotasks();
    expect(result.current.slashCatalogReady).toBe(false);
  });
});

describe("useSlashCommandMenu draft state and suggestions", () => {
  it("reports commandDraft false for plain text and true for a slash-prefixed draft", () => {
    const { result: plain } = setup({ draft: "hello" });
    expect(plain.current.commandDraft).toBe(false);

    const { result: command } = setup({ draft: "/goal" });
    expect(command.current.commandDraft).toBe(true);
  });

  it("flags an experimental command draft once the real catalog is loaded", async () => {
    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    const { result, rerender } = setup({ draft: "/deploy target", loadSlashCommands });
    await flushMicrotasks();
    rerender({ id: "agent-1", draft: "/deploy target", canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    expect(result.current.commandDraft).toBe(true);
    expect(result.current.experimentalCommandDraft).toBe(true);
  });

  it("filters slash command suggestions by prefix, ranking available before experimental before unavailable", async () => {
    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    const { result, rerender } = setup({ draft: "/", loadSlashCommands });
    await flushMicrotasks();
    rerender({ id: "agent-1", draft: "/", canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    expect(result.current.slashCommands.map((s) => s.command.name)).toEqual(["goal", "context", "deploy", "future"]);
  });

  it("gates slashMenuOpen on canSend, sending, and optionsOpen", async () => {
    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    const base = { draft: "/goal", loadSlashCommands, canSend: true, optionsOpen: false, sending: false };

    const open = setup(base);
    await flushMicrotasks();
    open.rerender({ id: "agent-1", setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn(), ...base });
    expect(open.result.current.slashMenuOpen).toBe(true);

    const whileSending = setup({ ...base, sending: true });
    await flushMicrotasks();
    expect(whileSending.result.current.slashMenuOpen).toBe(false);

    const whileOptionsOpen = setup({ ...base, optionsOpen: true });
    await flushMicrotasks();
    expect(whileOptionsOpen.result.current.slashMenuOpen).toBe(false);

    const withoutSend = setup({ ...base, canSend: false });
    expect(withoutSend.result.current.slashMenuOpen).toBe(false);
  });
});

async function readyResult(draft: string) {
  const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
  const utils = setup({ draft, loadSlashCommands });
  await flushMicrotasks();
  utils.rerender({ id: "agent-1", draft, canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: utils.setDrafts, setAttachmentStatus: utils.setAttachmentStatus, textareaRef: utils.textareaRef, closeOptions: utils.closeOptions });
  return utils;
}

describe("useSlashCommandMenu navigation and selection", () => {
  it("cycles the active suggestion with ArrowDown/ArrowUp, wrapping at the ends", async () => {
    const { result } = await readyResult("/");
    expect(result.current.activeSlashCommand?.command.name).toBe("goal");

    act(() => { result.current.handleTextareaKeyDown(key({ key: "ArrowDown" })); });
    expect(result.current.activeSlashCommandIndex).toBe(1);

    act(() => { result.current.handleTextareaKeyDown(key({ key: "ArrowUp" })); });
    act(() => { result.current.handleTextareaKeyDown(key({ key: "ArrowUp" })); });
    expect(result.current.activeSlashCommandIndex).toBe(3);
  });

  it("resets the active suggestion index whenever the draft changes", async () => {
    const { result, rerender } = await readyResult("/");
    act(() => { result.current.handleTextareaKeyDown(key({ key: "ArrowDown" })); });
    expect(result.current.activeSlashCommandIndex).toBe(1);

    rerender({ id: "agent-1", draft: "/g", canSend: true, optionsOpen: false, sending: false, loadSlashCommands: undefined, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    expect(result.current.activeSlashCommandIndex).toBe(0);
  });

  it("selectSlashCommand fills the draft, clears status, and refocuses the textarea", async () => {
    const { result, setDrafts, setAttachmentStatus, textareaRef } = await readyResult("/goal");
    const suggestion = result.current.slashCommands[0];

    act(() => { result.current.selectSlashCommand(suggestion); });
    const updater = setDrafts.mock.calls.at(-1)![0];
    expect(updater({})).toEqual({ "agent-1": "/goal " });
    expect(setAttachmentStatus).toHaveBeenCalledWith("");

    await flushMicrotasks();
    expect(textareaRef.current).toHaveFocus();
  });

  it("selectSlashCommand refuses an unavailable command and reports status instead", async () => {
    const { result, setDrafts, setAttachmentStatus } = await readyResult("/fut");
    const suggestion = result.current.slashCommands[0];
    expect(suggestion.command.availability).toBe("unavailable");

    act(() => { result.current.selectSlashCommand(suggestion); });
    expect(setDrafts).not.toHaveBeenCalled();
    expect(setAttachmentStatus).toHaveBeenCalledWith("This command was detected but is unavailable in the mobile UI.");
  });

  it("Tab completes the active available command and reports handled", async () => {
    const { result } = await readyResult("/goal");
    let handled = false;
    act(() => { handled = result.current.handleTextareaKeyDown(key({ key: "Tab" })); });
    expect(handled).toBe(true);
  });

  it("Tab does not complete an unavailable command and reports unhandled", async () => {
    const { result } = await readyResult("/fut");
    let handled = false;
    act(() => { handled = result.current.handleTextareaKeyDown(key({ key: "Tab" })); });
    expect(handled).toBe(false);
  });

  it("Enter selects the active suggestion unless the draft is already an exact no-argument match", async () => {
    const { result, setDrafts } = await readyResult("/con");
    let handled = false;
    act(() => { handled = result.current.handleTextareaKeyDown(key({ key: "Enter" })); });
    expect(handled).toBe(true);
    expect(setDrafts).toHaveBeenCalled();
  });

  it("Enter falls through when the draft already exactly matches a no-argument command", async () => {
    const { result, setDrafts } = await readyResult("/context");
    let handled = false;
    act(() => { handled = result.current.handleTextareaKeyDown(key({ key: "Enter" })); });
    expect(handled).toBe(false);
    expect(setDrafts).not.toHaveBeenCalled();
  });

  it("Enter falls through once the draft is the option suggestion it would write", async () => {
    const withOptions: SlashCommandCatalog = {
      ...catalog,
      commands: [...catalog.commands, {
        name: "model",
        description: "Switch model",
        source: "adapter",
        availability: "available",
        takesArguments: true,
        options: [{ value: "openai/other", label: "openai/other" }, { value: "openai/current", label: "openai/current", current: true }],
      }],
    };
    const draft = "/model openai/other";
    const loadSlashCommands = vi.fn().mockResolvedValue(withOptions);
    const { result, setDrafts, rerender, setAttachmentStatus, textareaRef, closeOptions } = setup({ draft, loadSlashCommands });
    await flushMicrotasks();
    rerender({ id: "agent-1", draft, canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts, setAttachmentStatus, textareaRef, closeOptions });
    expect(result.current.activeSlashCommand?.argumentValue).toBe("openai/other");
    let handled = false;
    act(() => { handled = result.current.handleTextareaKeyDown(key({ key: "Enter" })); });
    expect(handled).toBe(false);
    expect(setDrafts).not.toHaveBeenCalled();
  });

  it("Escape dismisses the menu only for the current draft", async () => {
    const { result, rerender } = await readyResult("/goal");
    act(() => { result.current.handleTextareaKeyDown(key({ key: "Escape" })); });
    expect(result.current.slashMenuOpen).toBe(false);

    rerender({ id: "agent-1", draft: "/goa", canSend: true, optionsOpen: false, sending: false, loadSlashCommands: undefined, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    expect(result.current.slashMenuOpen).toBe(true);
  });
});

describe("useSlashCommandMenu startSlashCommand and id reset", () => {
  it("seeds a bare slash when the draft is empty, closes options, and refocuses", async () => {
    const { result, setDrafts, closeOptions, textareaRef } = setup({ draft: "" });
    act(() => { result.current.startSlashCommand(); });
    const updater = setDrafts.mock.calls.at(-1)![0];
    expect(updater({})).toEqual({ "agent-1": "/" });
    expect(closeOptions).toHaveBeenCalledWith(false);

    await flushMicrotasks();
    expect(textareaRef.current).toHaveFocus();
  });

  it("preserves an existing non-blank draft when starting a slash command", () => {
    const { result, setDrafts } = setup({ draft: "keep me" });
    act(() => { result.current.startSlashCommand(); });
    const updater = setDrafts.mock.calls.at(-1)![0];
    expect(updater({ "agent-1": "keep me" })).toEqual({ "agent-1": "keep me" });
  });

  it("clears a dismissed draft when the agent id changes, reopening the menu for the same text", async () => {
    const { result, rerender } = await readyResult("/goal");
    act(() => { result.current.handleTextareaKeyDown(key({ key: "Escape" })); });
    expect(result.current.slashMenuOpen).toBe(false);

    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    rerender({ id: "agent-2", draft: "/goal", canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    await flushMicrotasks();
    expect(result.current.slashMenuOpen).toBe(true);
  });

  it("resets the active suggestion index when the agent id changes, even after the new catalog loads", async () => {
    const { result, rerender } = await readyResult("/");
    act(() => { result.current.handleTextareaKeyDown(key({ key: "ArrowDown" })); });
    expect(result.current.activeSlashCommandIndex).toBe(1);

    const loadSlashCommands = vi.fn().mockResolvedValue(catalog);
    rerender({ id: "agent-2", draft: "/", canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    await flushMicrotasks();
    rerender({ id: "agent-2", draft: "/", canSend: true, optionsOpen: false, sending: false, loadSlashCommands, setDrafts: vi.fn(), setAttachmentStatus: vi.fn(), textareaRef: makeTextarea(), closeOptions: vi.fn() });
    expect(result.current.activeSlashCommandIndex).toBe(0);
  });
});

describe("experimentalCommandNotice", () => {
  it("differentiates extension-sourced commands from adapter ones", () => {
    expect(experimentalCommandNotice(catalog.commands[2])).toContain("extension code");
    expect(experimentalCommandNotice(catalog.commands[0])).toContain("model prompt");
  });
});
