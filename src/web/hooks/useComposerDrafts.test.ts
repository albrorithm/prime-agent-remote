import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DRAFTS_KEY, loadDrafts, MAX_DRAFT_LENGTH, MAX_STORED_DRAFT_BYTES, MAX_STORED_DRAFTS, useComposerDrafts } from "./useComposerDrafts";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("loadDrafts", () => {
  it("returns an empty map when nothing is stored or storage is corrupt", () => {
    expect(loadDrafts()).toEqual({});
    localStorage.setItem(DRAFTS_KEY, "not json");
    expect(loadDrafts()).toEqual({});
  });

  it("rejects non-object and array payloads", () => {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify("a string"));
    expect(loadDrafts()).toEqual({});
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(["one", "two"]));
    expect(loadDrafts()).toEqual({});
  });

  it("drops the __proto__ key and non-string entries", () => {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({
      "agent-1": 42,
      "agent-2": "kept",
      __proto__: "ignored",
    }));
    expect(loadDrafts()).toEqual({ "agent-2": "kept" });
  });

  it("drops entries with an oversized agent id", () => {
    const longId = "a".repeat(257);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ [longId]: "draft", short: "kept" }));
    expect(loadDrafts()).toEqual({ short: "kept" });
  });

  it("truncates overly long draft text", () => {
    const huge = "x".repeat(MAX_DRAFT_LENGTH + 50);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ agent: huge }));
    expect(loadDrafts().agent).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it("caps the number of restored entries", () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < MAX_STORED_DRAFTS + 20; index += 1) entries[`agent-${index}`] = "draft";
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(entries));
    expect(Object.keys(loadDrafts())).toHaveLength(MAX_STORED_DRAFTS);
  });

  it("short-circuits without parsing when the stored payload is too large", () => {
    // A single giant string value keeps this under MAX_STORED_DRAFTS while
    // still tripping the byte-length guard before JSON.parse runs.
    const oversized = JSON.stringify({ agent: "x".repeat(MAX_STORED_DRAFT_BYTES + 10) });
    localStorage.setItem(DRAFTS_KEY, oversized);
    expect(loadDrafts()).toEqual({});
  });

  describe("sessionStorage migration", () => {
    it("migrates a legacy sessionStorage draft into localStorage on first read", () => {
      sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "carried over" }));
      expect(loadDrafts()).toEqual({ "agent-1": "carried over" });
      expect(localStorage.getItem(DRAFTS_KEY)).toContain("carried over");
      expect(sessionStorage.getItem(DRAFTS_KEY)).toBeNull();
    });

    it("prefers localStorage over a legacy sessionStorage entry once migrated", () => {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "current" }));
      sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "stale" }));
      expect(loadDrafts()).toEqual({ "agent-1": "current" });
    });

    it("does not resurrect anything when neither storage has a draft", () => {
      expect(loadDrafts()).toEqual({});
      expect(localStorage.getItem(DRAFTS_KEY)).toBeNull();
    });

    it("validates a legacy sessionStorage payload the same way as localStorage", () => {
      sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": 42, "agent-2": "kept" }));
      expect(loadDrafts()).toEqual({ "agent-2": "kept" });
    });
  });
});

describe("useComposerDrafts", () => {
  it("reads the initial draft for an agent from local storage", () => {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "hello" }));
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    expect(result.current.draft).toBe("hello");
  });

  it("returns an empty string for an agent with no stored draft", () => {
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    expect(result.current.draft).toBe("");
  });

  it("persists updates to local storage and reflects the new draft", () => {
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    act(() => {
      result.current.setDrafts((current) => ({ ...current, "agent-1": "typed text" }));
    });
    expect(result.current.draft).toBe("typed text");
    expect(localStorage.getItem(DRAFTS_KEY)).toContain("typed text");
  });

  it("keeps drafts in memory when local storage writes throw", () => {
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
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "one", "agent-2": "two" }));
    const { result, rerender } = renderHook(({ id }) => useComposerDrafts(id), { initialProps: { id: "agent-1" } });
    expect(result.current.draft).toBe("one");
    rerender({ id: "agent-2" });
    expect(result.current.draft).toBe("two");
  });

  it("picks up a draft carried over from the legacy sessionStorage key", () => {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "from an old tab" }));
    const { result } = renderHook(() => useComposerDrafts("agent-1"));
    expect(result.current.draft).toBe("from an old tab");
    expect(sessionStorage.getItem(DRAFTS_KEY)).toBeNull();
  });

  describe("cross-tab reconciliation", () => {
    function fireStorageEvent(newValue: string | null, oldValue: string | null = null) {
      window.dispatchEvent(new StorageEvent("storage", { key: DRAFTS_KEY, newValue, oldValue }));
    }

    it("adopts another tab's newer draft for an id this tab hasn't touched", () => {
      const { result } = renderHook(() => useComposerDrafts("agent-1"));
      expect(result.current.draft).toBe("");

      act(() => {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify({ "agent-1": "typed in another tab" }));
        fireStorageEvent(JSON.stringify({ "agent-1": "typed in another tab" }));
      });

      expect(result.current.draft).toBe("typed in another tab");
    });

    it("does not clobber this tab's in-progress edit with a stale cross-tab write", () => {
      const { result } = renderHook(() => useComposerDrafts("agent-1"));
      act(() => {
        result.current.setDrafts((current) => ({ ...current, "agent-1": "this tab's edit" }));
      });
      expect(result.current.draft).toBe("this tab's edit");

      // Another tab's write races in after this tab already diverged from
      // its last known sync (empty) — this tab's active edit must survive.
      act(() => {
        fireStorageEvent(JSON.stringify({ "agent-1": "other tab's stale value" }));
      });

      expect(result.current.draft).toBe("this tab's edit");
    });

    it("adopts an update for an untouched id while leaving an actively-edited id alone", () => {
      const { result } = renderHook(() => useComposerDrafts("agent-1"));
      act(() => {
        result.current.setDrafts((current) => ({ ...current, "agent-1": "editing here" }));
      });

      act(() => {
        localStorage.setItem(
          DRAFTS_KEY,
          JSON.stringify({ "agent-1": "clobber attempt", "agent-2": "from another tab" }),
        );
        fireStorageEvent(JSON.stringify({ "agent-1": "clobber attempt", "agent-2": "from another tab" }));
      });

      expect(result.current.draft).toBe("editing here");
      const { result: other } = renderHook(() => useComposerDrafts("agent-2"));
      expect(other.current.draft).toBe("from another tab");
    });

    it("ignores storage events for unrelated keys", () => {
      const { result } = renderHook(() => useComposerDrafts("agent-1"));
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "some-other-key",
            newValue: JSON.stringify({ "agent-1": "should not apply" }),
          }),
        );
      });
      expect(result.current.draft).toBe("");
    });

    it("does not throw on a malformed cross-tab payload", () => {
      const { result } = renderHook(() => useComposerDrafts("agent-1"));
      expect(() => {
        act(() => fireStorageEvent("not json"));
      }).not.toThrow();
      expect(result.current.draft).toBe("");
    });
  });
});
