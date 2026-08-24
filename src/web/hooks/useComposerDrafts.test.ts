import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DRAFTS_KEY, loadDrafts, MAX_DRAFT_LENGTH, MAX_STORED_DRAFT_BYTES, MAX_STORED_DRAFTS, useComposerDrafts } from "./useComposerDrafts";

beforeEach(() => {
  sessionStorage.clear();
});

describe("loadDrafts", () => {
  it("returns an empty map when nothing is stored or storage is corrupt", () => {
    expect(loadDrafts()).toEqual({});
    sessionStorage.setItem(DRAFTS_KEY, "not json");
    expect(loadDrafts()).toEqual({});
  });

  it("rejects non-object and array payloads", () => {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify("a string"));
    expect(loadDrafts()).toEqual({});
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(["one", "two"]));
    expect(loadDrafts()).toEqual({});
  });

  it("drops the __proto__ key and non-string entries", () => {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({
      "agent-1": 42,
      "agent-2": "kept",
      __proto__: "ignored",
    }));
    expect(loadDrafts()).toEqual({ "agent-2": "kept" });
  });

  it("drops entries with an oversized agent id", () => {
    const longId = "a".repeat(257);
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ [longId]: "draft", short: "kept" }));
    expect(loadDrafts()).toEqual({ short: "kept" });
  });

  it("truncates overly long draft text", () => {
    const huge = "x".repeat(MAX_DRAFT_LENGTH + 50);
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ agent: huge }));
    expect(loadDrafts().agent).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it("caps the number of restored entries", () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < MAX_STORED_DRAFTS + 20; index += 1) entries[`agent-${index}`] = "draft";
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(entries));
    expect(Object.keys(loadDrafts())).toHaveLength(MAX_STORED_DRAFTS);
  });

  it("short-circuits without parsing when the stored payload is too large", () => {
    // A single giant string value keeps this under MAX_STORED_DRAFTS while
    // still tripping the byte-length guard before JSON.parse runs.
    const oversized = JSON.stringify({ agent: "x".repeat(MAX_STORED_DRAFT_BYTES + 10) });
    sessionStorage.setItem(DRAFTS_KEY, oversized);
    expect(loadDrafts()).toEqual({});
  });
});

describe("useComposerDrafts", () => {
  it("reads the initial draft for an agent from session storage", () => {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "hello" }));
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    expect(result.current.draft).toBe("hello");
  });

  it("returns an empty string for an agent with no stored draft", () => {
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    expect(result.current.draft).toBe("");
  });

  it("persists updates to session storage and reflects the new draft", () => {
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    act(() => {
      result.current.setDrafts((current) => ({ ...current, "agent-1": "typed text" }));
    });
    expect(result.current.draft).toBe("typed text");
    expect(sessionStorage.getItem(DRAFTS_KEY)).toContain("typed text");
  });

  it("keeps drafts in memory when session storage writes throw", () => {
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      act(() => {
        result.current.setDrafts((current) => ({ ...current, "agent-1": "still works" }));
      });
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(result.current.draft).toBe("still works");
  });

  it("swaps to a different agent's draft when the id changes", () => {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "one", "agent-2": "two" }));
    const { result, rerender } = renderHook(({ id }) => useComposerDrafts(id), { initialProps: { id: "agent-1" } });
    expect(result.current.draft).toBe("one");
    rerender({ id: "agent-2" });
    expect(result.current.draft).toBe("two");
  });
});
