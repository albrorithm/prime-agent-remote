import { describe, expect, it } from "vitest";
import { uniqueSessionName } from "./backend.js";

describe("uniqueSessionName", () => {
  it("keeps a name nobody else has", () => {
    expect(uniqueSessionName("Fresh", ["Other"])).toBe("Fresh");
  });

  it("suffixes duplicates case-insensitively", () => {
    expect(uniqueSessionName("fresh", ["FRESH"])).toBe("fresh 2");
    expect(uniqueSessionName("fresh", ["Fresh", "fresh 2", "FRESH 3"])).toBe("fresh 4");
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(uniqueSessionName("demo", [" demo "])).toBe("demo 2");
  });
});
