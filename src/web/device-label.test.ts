import { describe, expect, it } from "vitest";
import { deviceLabel } from "./device-label";

const AGENTS = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipadMobile: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

function withTouchPoints<T>(points: number, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: points });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(navigator, "maxTouchPoints", original);
    else delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
  }
}

describe("deviceLabel", () => {
  it("names the devices this actually ships to", () => {
    expect(deviceLabel(AGENTS.iphone)).toBe("iPhone");
    expect(deviceLabel(AGENTS.ipadMobile)).toBe("iPad");
    expect(deviceLabel(AGENTS.android)).toBe("Android");
    expect(deviceLabel(AGENTS.chromebook)).toBe("Chromebook");
    expect(deviceLabel(AGENTS.windows)).toBe("Windows PC");
    expect(deviceLabel(AGENTS.linux)).toBe("Linux");
  });

  // Android's user agent says Linux, and a Chromebook's says X11 — order in the
  // pattern list is doing real work, not decoration.
  it("does not let a broader pattern swallow a narrower one", () => {
    expect(deviceLabel(AGENTS.android)).not.toBe("Linux");
    expect(deviceLabel(AGENTS.chromebook)).not.toBe("Linux");
  });

  it("tells an iPad in desktop mode from an actual Mac", () => {
    // Desktop-mode Safari on an iPad claims to be a Macintosh. An iPad filed as
    // "Mac" is a device its owner will not recognise in the list.
    expect(withTouchPoints(5, () => deviceLabel(AGENTS.ipadDesktop))).toBe("iPad");
    expect(withTouchPoints(0, () => deviceLabel(AGENTS.mac))).toBe("Mac");
  });

  it("still answers something for an agent it does not know", () => {
    expect(deviceLabel("")).toBe("Device");
    expect(deviceLabel("Some/Unknown 1.0")).toBe("Device");
  });

  // The schema caps deviceName at 64 characters and rejects an empty string, so
  // anything returned here has to be a legal pairing request on its own.
  it("always returns something the pairing schema will accept", () => {
    for (const agent of [...Object.values(AGENTS), "", "junk"]) {
      const label = deviceLabel(agent);
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(64);
      expect(label).toBe(label.trim());
    }
  });
});
