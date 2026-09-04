import { describe, expect, it } from "vitest";
import { formatCoarseDuration } from "./duration";

describe("formatCoarseDuration", () => {
  it("uses seconds below a minute", () => {
    expect(formatCoarseDuration(0)).toBe("0s");
    expect(formatCoarseDuration(59)).toBe("59s");
  });

  it("uses whole minutes below an hour", () => {
    expect(formatCoarseDuration(60)).toBe("1m");
    expect(formatCoarseDuration(3_599)).toBe("59m");
  });

  it("uses hours and minutes above an hour", () => {
    expect(formatCoarseDuration(3_600)).toBe("1h 0m");
    expect(formatCoarseDuration(7_830)).toBe("2h 10m");
  });

  // The dashboard divides milliseconds in, so fractions arrive here.
  it("rounds a fractional input rather than showing it", () => {
    expect(formatCoarseDuration(1.4)).toBe("1s");
    expect(formatCoarseDuration(1.6)).toBe("2s");
  });

  // A clock skew between the daemon and this machine can produce one.
  it("floors a negative duration at zero instead of printing it", () => {
    expect(formatCoarseDuration(-5)).toBe("0s");
  });
});
