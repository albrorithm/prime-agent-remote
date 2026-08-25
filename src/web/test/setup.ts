import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 22+ ships a global `localStorage` that vitest's jsdom bridge treats as
// already-present and therefore never overrides with jsdom's real, working
// implementation (see populateGlobal's `k in global` check) — accessing it
// here is silently `undefined` rather than a Storage instance. `sessionStorage`
// has no such Node global, so jsdom's copy comes through untouched. Patch
// `localStorage` with a real in-memory Storage so code under test (and this
// file's own `.clear()` below) sees normal browser behavior.
if (typeof globalThis.localStorage === "undefined") {
  class MemoryStorage implements Storage {
    #store = new Map<string, string>();
    get length() { return this.#store.size; }
    clear() { this.#store.clear(); }
    getItem(key: string) { return this.#store.has(key) ? this.#store.get(key)! : null; }
    key(index: number) { return [...this.#store.keys()][index] ?? null; }
    removeItem(key: string) { this.#store.delete(key); }
    setItem(key: string, value: string) { this.#store.set(key, String(value)); }
  }
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
