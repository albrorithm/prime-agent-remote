import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const SETTINGS_KEY = "prime-web-settings";
export const SETTINGS_VERSION = 1;
/** A stored payload larger than this is treated as corrupt rather than parsed. */
const MAX_STORED_SETTINGS_BYTES = 10_000;

export const TEXT_SCALES = [1, 1.15, 1.3] as const;
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type MotionPreference = "system" | "always";

export interface Settings {
  version: number;
  theme: ThemePreference;
  textScale: number;
  reduceMotion: MotionPreference;
  codeWrap: boolean;
  syntaxHighlight: boolean;
  rawMarkdown: boolean;
  timestamps: boolean;
  turnsCollapsed: boolean;
  enterSends: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  theme: "system",
  textScale: 1,
  reduceMotion: "system",
  codeWrap: false,
  syntaxHighlight: true,
  rawMarkdown: false,
  timestamps: true,
  turnsCollapsed: true,
  enterSends: true,
};

function pickString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Snaps to the nearest offered scale so a hand-edited value can't wedge the UI. */
function pickTextScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.textScale;
  return TEXT_SCALES.reduce((best, scale) =>
    Math.abs(scale - value) < Math.abs(best - value) ? scale : best);
}

/**
 * Field-by-field coercion rather than all-or-nothing validation: a payload
 * written by a newer build (unknown fields, a bumped `version`) still yields
 * usable settings instead of silently resetting everything the user chose.
 */
export function normalizeSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
  const stored = value as Record<string, unknown>;
  return {
    version: SETTINGS_VERSION,
    theme: pickString(stored.theme, ["dark", "light", "system"], DEFAULT_SETTINGS.theme),
    textScale: pickTextScale(stored.textScale),
    reduceMotion: pickString(stored.reduceMotion, ["system", "always"], DEFAULT_SETTINGS.reduceMotion),
    codeWrap: pickBoolean(stored.codeWrap, DEFAULT_SETTINGS.codeWrap),
    syntaxHighlight: pickBoolean(stored.syntaxHighlight, DEFAULT_SETTINGS.syntaxHighlight),
    rawMarkdown: pickBoolean(stored.rawMarkdown, DEFAULT_SETTINGS.rawMarkdown),
    timestamps: pickBoolean(stored.timestamps, DEFAULT_SETTINGS.timestamps),
    turnsCollapsed: pickBoolean(stored.turnsCollapsed, DEFAULT_SETTINGS.turnsCollapsed),
    enterSends: pickBoolean(stored.enterSends, DEFAULT_SETTINGS.enterSends),
  };
}

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored === null || stored.length > MAX_STORED_SETTINGS_BYTES) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(stored));
  } catch {
    // Storage unavailable (private browsing) or the payload is not JSON.
    return { ...DEFAULT_SETTINGS };
  }
}

function prefersDark(): boolean {
  try {
    return window.matchMedia(DARK_SCHEME_QUERY).matches;
  } catch {
    return true;
  }
}

export function resolveTheme(theme: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

/**
 * The `<meta name="theme-color">` value per theme, which iOS uses to tint the
 * standalone status bar and Chrome the browser chrome. These track `--bg`,
 * because that is what sits behind the safe-area inset in `.app-shell`.
 */
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#000000", light: "#fdfcfa" };

/**
 * Writes the settings that CSS reads. `public/theme-init.js` performs the same
 * writes before first paint; keep the two in sync when adding a stamped value.
 */
export function applySettings(settings: Settings, systemPrefersDark: boolean): void {
  const root = document.documentElement;
  const theme = resolveTheme(settings.theme, systemPrefersDark);
  root.dataset.theme = theme;
  root.dataset.reduceMotion = settings.reduceMotion;
  root.style.setProperty("--text-scale", String(settings.textScale));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

export interface SettingsContextValue {
  settings: Settings;
  resolvedTheme: ResolvedTheme;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemPrefersDark, setSystemPrefersDark] = useState(prefersDark);

  // Without this, a user on "system" who flips OS appearance mid-session keeps
  // the theme that was resolved at launch.
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(DARK_SCHEME_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applySettings(settings, systemPrefersDark);
  }, [settings, systemPrefersDark]);

  // Persisting here rather than in the setters keeps the state updaters pure —
  // StrictMode invokes those twice in dev. The first run is skipped so merely
  // opening the app doesn't write defaults over a payload a newer build wrote.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Storage may be unavailable; settings still apply for this session.
    }
  }, [settings]);

  const setSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const resetSettings = useCallback(() => setSettings({ ...DEFAULT_SETTINGS }), []);

  const value = useMemo<SettingsContextValue>(() => ({
    settings,
    resolvedTheme: resolveTheme(settings.theme, systemPrefersDark),
    setSetting,
    resetSettings,
  }), [settings, systemPrefersDark, setSetting, resetSettings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside a SettingsProvider");
  return value;
}
