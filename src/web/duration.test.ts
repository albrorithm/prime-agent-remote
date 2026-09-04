import { describe, expect, it } from "vitest";
import { formatCoarseDuration } from "./duration";

describe("formatCoarseDuration", () => {
  it.each([
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [3_599, "59m"],
    [3_600, "1h 0m"],
    [7_830, "2h 10m"],
  ])("formats %d seconds as %s", (seconds, label) => {
    expect(formatCoarseDuration(seconds)).toBe(label);
  });

  // The dashboard divides milliseconds in, so fractions arrive here, and a
  // clock skew between the daemon and this machine can make one negative.
  it("rounds a fraction and floors a negative at zero", () => {
    expect(formatCoarseDuration(1.4)).toBe("1s");
    expect(formatCoarseDuration(1.6)).toBe("2s");
    expect(formatCoarseDuration(-5)).toBe("0s");
  });
});
