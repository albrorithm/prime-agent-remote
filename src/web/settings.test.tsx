import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySettings,
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  resolveTheme,
  SETTINGS_KEY,
  SettingsProvider,
  THEME_COLORS,
  useSettings,
} from "./settings";

let schemeListeners: Array<(event: MediaQueryListEvent) => void> = [];
let systemDark = true;

/** jsdom has no matchMedia, and the provider subscribes to scheme changes. */
function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: systemDark,
      media: query,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
        schemeListeners.push(listener);
      },
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
        schemeListeners = schemeListeners.filter((entry) => entry !== listener);
      },
    }),
  });
}

function emitSchemeChange(matches: boolean) {
  systemDark = matches;
  act(() => {
    for (const listener of [...schemeListeners]) listener({ matches } as MediaQueryListEvent);
  });
}

function Probe() {
  const { settings, resolvedTheme, setSetting, resetSettings } = useSettings();
  return (
    <>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="enter-sends">{String(settings.enterSends)}</span>
      <button onClick={() => setSetting("theme", "light")}>go light</button>
      <button onClick={() => setSetting("enterSends", false)}>enter newlines</button>
      <button onClick={resetSettings}>reset</button>
    </>
  );
}

function renderProvider() {
  return render(<SettingsProvider><Probe /></SettingsProvider>);
}

beforeEach(() => {
  schemeListeners = [];
  systemDark = true;
  installMatchMedia();
});

function addThemeColorMeta(): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#000000");
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.style.removeProperty("--text-scale");
});

describe("normalizeSettings", () => {
  it("keeps values it recognises", () => {
    const settings = normalizeSettings({ theme: "light", textScale: 1.3, enterSends: false });

    expect(settings.theme).toBe("light");
    expect(settings.textScale).toBe(1.3);
    expect(settings.enterSends).toBe(false);
  });

  it("falls back per field rather than discarding the whole payload", () => {
    const settings = normalizeSettings({ theme: "chartreuse", enterSends: false });

    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(settings.enterSends).toBe(false);
  });

  it("survives a payload from a newer build", () => {
    const settings = normalizeSettings({ version: 99, theme: "light", somethingNew: { deep: true } });

    expect(settings.theme).toBe("light");
    expect(settings.reduceMotion).toBe(DEFAULT_SETTINGS.reduceMotion);
  });

  it("snaps a hand-edited text scale to the nearest offered value", () => {
    expect(normalizeSettings({ textScale: 1.14 }).textScale).toBe(1.15);
    expect(normalizeSettings({ textScale: 9000 }).textScale).toBe(1.3);
    expect(normalizeSettings({ textScale: "big" }).textScale).toBe(DEFAULT_SETTINGS.textScale);
  });

  it("rejects a non-object", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });
});

describe("loadSettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for unparseable storage", () => {
    localStorage.setItem(SETTINGS_KEY, "{{{");

    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("ignores an implausibly large payload instead of parsing it", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: "light", pad: "x".repeat(20_000) }));

    expect(loadSettings().theme).toBe(DEFAULT_SETTINGS.theme);
  });
});

describe("resolveTheme", () => {
  it("follows the system preference only for 'system'", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("SettingsProvider", () => {
  it("stamps the resolved theme, motion, and scale on mount", () => {
    renderProvider();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.reduceMotion).toBe("system");
    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("1");
  });

  it("does not write storage merely by opening the app", () => {
    renderProvider();

    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("persists and restamps when a setting changes", async () => {
    const user = userEvent.setup();
    renderProvider();

    await user.click(screen.getByRole("button", { name: "go light" }));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).theme).toBe("light");
  });

  it("restores defaults", async () => {
    const user = userEvent.setup();
    renderProvider();

    await user.click(screen.getByRole("button", { name: "enter newlines" }));
    expect(screen.getByTestId("enter-sends")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByTestId("enter-sends")).toHaveTextContent("true");
  });

  it("follows the OS flipping appearance mid-session while on 'system'", () => {
    renderProvider();
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");

    emitSchemeChange(false);

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores the OS preference once a theme is chosen explicitly", async () => {
    const user = userEvent.setup();
    renderProvider();

    await user.click(screen.getByRole("button", { name: "go light" }));
    emitSchemeChange(true);

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });
});

describe("applySettings", () => {
  it("stamps theme-color with the resolved theme's background", () => {
    const meta = addThemeColorMeta();

    applySettings({ ...DEFAULT_SETTINGS, theme: "light" }, true);
    expect(meta.getAttribute("content")).toBe(THEME_COLORS.light);

    applySettings({ ...DEFAULT_SETTINGS, theme: "dark" }, false);
    expect(meta.getAttribute("content")).toBe(THEME_COLORS.dark);
  });

  it("follows the system preference when the theme is 'system'", () => {
    const meta = addThemeColorMeta();

    applySettings({ ...DEFAULT_SETTINGS, theme: "system" }, false);
    expect(meta.getAttribute("content")).toBe(THEME_COLORS.light);

    applySettings({ ...DEFAULT_SETTINGS, theme: "system" }, true);
    expect(meta.getAttribute("content")).toBe(THEME_COLORS.dark);
  });

  // A shell without the meta (tests, a stripped host page) must still theme.
  it("still stamps the root when no theme-color meta exists", () => {
    expect(() => applySettings({ ...DEFAULT_SETTINGS, theme: "light" }, true)).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
