import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionOrganization,
  MAX_ORGANIZED_SESSION_IDS,
  SESSION_ORGANIZATION_SCHEMA_VERSION,
  SESSION_ORGANIZATION_STORAGE_KEY,
  useSessionOrganization,
} from "./useSessionOrganization";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("useSessionOrganization", () => {
  it("remembers pins and archives on this device, and a pin and an archive never coexist", () => {
    const { result } = renderHook(() => useSessionOrganization());
    act(() => result.current.togglePin("a"));
    act(() => result.current.toggleArchive("b"));
    expect([...result.current.pinned]).toEqual(["a"]);
    expect([...result.current.archived]).toEqual(["b"]);

    // Hiding a pinned session drops its pin; pinning a hidden one reveals it.
    act(() => result.current.toggleArchive("a"));
    expect(result.current.pinned.has("a")).toBe(false);
    expect(result.current.archived.has("a")).toBe(true);
    act(() => result.current.togglePin("a"));
    expect(result.current.archived.has("a")).toBe(false);

    const stored = JSON.parse(localStorage.getItem(SESSION_ORGANIZATION_STORAGE_KEY)!) as { version: number; pinned: string[]; archived: string[] };
    expect(stored.version).toBe(SESSION_ORGANIZATION_SCHEMA_VERSION);
    expect(stored.pinned).toEqual(["a"]);
    const { result: again } = renderHook(() => useSessionOrganization());
    expect([...again.current.pinned]).toEqual(["a"]);
  });

  it("keeps the newest ids when the bound is passed, and discards a shape it does not know", () => {
    const { result } = renderHook(() => useSessionOrganization());
    act(() => {
      for (let index = 0; index <= MAX_ORGANIZED_SESSION_IDS; index += 1) result.current.togglePin(`s${index}`);
    });
    expect(result.current.pinned.size).toBe(MAX_ORGANIZED_SESSION_IDS);
    expect(result.current.pinned.has("s0")).toBe(false);
    expect(result.current.pinned.has(`s${MAX_ORGANIZED_SESSION_IDS}`)).toBe(true);

    localStorage.setItem(SESSION_ORGANIZATION_STORAGE_KEY, JSON.stringify({ version: 99, pinned: ["x"], archived: [] }));
    expect(loadSessionOrganization()).toEqual({ pinned: [], archived: [] });
    localStorage.setItem(SESSION_ORGANIZATION_STORAGE_KEY, "not json");
    expect(loadSessionOrganization()).toEqual({ pinned: [], archived: [] });
  });

  it("works without storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    const { result } = renderHook(() => useSessionOrganization());
    act(() => result.current.togglePin("a"));
    expect(result.current.pinned.has("a")).toBe(true);
  });
});
