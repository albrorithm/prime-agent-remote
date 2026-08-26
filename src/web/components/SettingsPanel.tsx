import { Bell, BellOff, LogOut, Settings as SettingsIcon, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PROTOCOL_VERSION } from "../../protocol";
import { humanizeError } from "../api";
import { useGateway } from "../gateway-store";
import { DRAFTS_KEY } from "../hooks/useComposerDrafts";
import { disablePush, enablePush, readPushState, type PushState } from "../push";
import { SETTINGS_KEY, TEXT_SCALES, useSettings, type Settings } from "../settings";

interface SettingsPanelProps {
  onClose: () => void;
}

interface ToggleProps {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function Toggle({ id, label, hint, checked, onChange }: ToggleProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label htmlFor={id}>{label}</label>
        <p id={`${id}-hint`} className="settings-hint">{hint}</p>
      </div>
      <input
        id={id}
        className="settings-toggle"
        type="checkbox"
        checked={checked}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

interface ChoiceProps<T extends string> {
  name: string;
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
  children?: ReactNode;
}

function Choice<T extends string>({ name, legend, options, value, disabled, onChange, children }: ChoiceProps<T>) {
  return (
    <fieldset className="settings-choice" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="settings-options">
        {options.map((option) => (
          <label key={option.value} className="settings-option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}

const TEXT_SCALE_LABELS = ["Default", "Larger", "Largest"];

type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function backendLabel(backend: "demo" | "prime" | null): string {
  if (backend === "demo") return "Demo data";
  if (backend === "prime") return "Prime Agent";
  return "Not connected";
}

/**
 * Copy for every state a phone can actually be in. `denied` gets its own
 * wording because a page whose prompt was refused can never show it again;
 * offering "turn on" there would send the user round a loop with no exit.
 */
const PUSH_COPY: Record<PushState, { hint: string; action?: string }> = {
  unsupported: {
    hint: "This browser can't receive notifications. On iPhone, add Prime Agent to the Home Screen and open it from there.",
  },
  unconfigured: {
    hint: "This gateway has no notification keys configured. Ask whoever runs it to set the VAPID keys.",
  },
  denied: {
    hint: "Notifications are blocked for this app. Turn them back on in your device settings — this page can't ask again.",
  },
  off: {
    hint: "Get woken when a session needs a decision. The alert names the session and nothing else — never transcript text.",
    action: "Turn on notifications",
  },
  on: {
    hint: "This device is woken when a session needs a decision, and the app icon shows how many are waiting.",
    action: "Turn off notifications",
  },
};

function NotificationsGroup() {
  const { csrfToken, push } = useGateway();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState(await readPushState(push));
  }, [push]);

  useEffect(() => {
    let current = true;
    void readPushState(push).then((value) => { if (current) setState(value); });
    return () => { current = false; };
  }, [push]);

  // Permission is requested here and nowhere else: the browser only honours
  // `requestPermission` inside a user gesture, and a prompt fired on load is
  // the fastest way to a permanent denial.
  async function toggle(turnOn: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (turnOn) setState(await enablePush(push?.publicKey ?? "", csrfToken));
      else {
        await disablePush(csrfToken);
        await refresh();
      }
    } catch (caught) {
      setError(humanizeError(caught, turnOn ? "Could not turn on notifications" : "Could not turn off notifications"));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;
  const copy = PUSH_COPY[state];
  const on = state === "on";
  return (
    <section className="settings-group" aria-labelledby="settings-notifications">
      <h3 id="settings-notifications">Notifications</h3>
      <div className="settings-row">
        <div className="settings-row-copy">
          <p className="settings-status">{on ? "On for this device" : "Off"}</p>
          <p className="settings-hint">{copy.hint}</p>
        </div>
      </div>
      {copy.action && (
        <div className="settings-actions">
          <button
            className={on ? "settings-quiet" : "primary-button"}
            disabled={busy}
            onClick={() => void toggle(!on)}
          >
            {on ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />} {copy.action}
          </button>
        </div>
      )}
      {error && <p className="settings-hint settings-error" role="alert">{error}</p>}
    </section>
  );
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { backend, signOut } = useGateway();
  const { settings, setSetting } = useSettings();
  const [confirmingClear, setConfirmingClear] = useState(false);

  const toggle = (key: BooleanSetting) => (value: boolean) => setSetting(key, value);

  function clearLocalData() {
    try {
      localStorage.removeItem(DRAFTS_KEY);
      localStorage.removeItem(SETTINGS_KEY);
    } catch {
      // Storage may be unavailable; the reload below still restores defaults.
    }
    try {
      sessionStorage.removeItem(DRAFTS_KEY);
    } catch {
      // Same.
    }
    window.location.reload();
  }

  return (
    <section className="panel settings-panel" aria-labelledby="settings-heading">
      <header className="drawer-header">
        <div className="drawer-title">
          <SettingsIcon aria-hidden="true" />
          <div><p className="eyebrow">Prime Agent</p><h2 id="settings-heading">Settings</h2></div>
        </div>
        {/* Deliberately not `.drawer-close`: that class hides at ≥1100px, but this
            backs out of the Settings sub-view, which desktop still needs. */}
        <button className="icon-button" onClick={onClose} aria-label="Close settings"><X /></button>
      </header>

      <div className="panel-scroll settings-scroll">
        <section className="settings-group" aria-labelledby="settings-appearance">
          <h3 id="settings-appearance">Appearance</h3>
          <Choice
            name="reduce-motion"
            legend="Motion"
            value={settings.reduceMotion}
            options={[
              { value: "system", label: "Follow system" },
              { value: "always", label: "Always reduce" },
            ]}
            onChange={(value) => setSetting("reduceMotion", value)}
          />
          <Choice
            name="theme"
            legend="Theme"
            value={settings.theme}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
            onChange={(value) => setSetting("theme", value)}
          />
          <Choice
            name="text-scale"
            legend="Text size"
            value={String(settings.textScale)}
            options={TEXT_SCALES.map((scale, index) => ({ value: String(scale), label: TEXT_SCALE_LABELS[index] }))}
            onChange={(value) => setSetting("textScale", Number(value))}
          />
        </section>

        <NotificationsGroup />

        <section className="settings-group" aria-labelledby="settings-reading">
          <h3 id="settings-reading">Reading</h3>
          <Toggle
            id="setting-code-wrap"
            label="Wrap long code lines"
            hint="Wrap instead of scrolling code blocks sideways."
            checked={settings.codeWrap}
            onChange={toggle("codeWrap")}
          />
          <Toggle
            id="setting-syntax-highlight"
            label="Syntax highlighting"
            hint="Color code blocks by language."
            checked={settings.syntaxHighlight}
            onChange={toggle("syntaxHighlight")}
          />
          <Toggle
            id="setting-raw-markdown"
            label="Show raw Markdown"
            hint="Show the source text instead of rendered Markdown."
            checked={settings.rawMarkdown}
            onChange={toggle("rawMarkdown")}
          />
          <Toggle
            id="setting-timestamps"
            label="Timestamps"
            hint="Show the time beside messages and rows."
            checked={settings.timestamps}
            onChange={toggle("timestamps")}
          />
          <Toggle
            id="setting-turns-collapsed"
            label="Collapse finished turns"
            hint="Fold a turn's tool work once it completes."
            checked={settings.turnsCollapsed}
            onChange={toggle("turnsCollapsed")}
          />
        </section>

        <section className="settings-group" aria-labelledby="settings-composer">
          <h3 id="settings-composer">Composer</h3>
          <Toggle
            id="setting-enter-sends"
            label="Enter sends message"
            hint={settings.enterSends ? "Shift+Enter adds a newline." : "Enter adds a newline; send with the button."}
            checked={settings.enterSends}
            onChange={toggle("enterSends")}
          />
        </section>

        <section className="settings-group" aria-labelledby="settings-about">
          <h3 id="settings-about">About</h3>
          <dl className="settings-facts">
            <div><dt>Backend</dt><dd>{backendLabel(backend)}</dd></div>
            <div><dt>Protocol</dt><dd>v{PROTOCOL_VERSION}</dd></div>
          </dl>
          <div className="settings-actions">
            {confirmingClear ? (
              <>
                <p className="settings-hint">Clears saved drafts and settings on this device, then reloads.</p>
                <button className="settings-danger" onClick={clearLocalData}>Clear local data</button>
                <button className="settings-quiet" onClick={() => setConfirmingClear(false)}>Cancel</button>
              </>
            ) : (
              <button className="settings-quiet" onClick={() => setConfirmingClear(true)}>
                <Trash2 aria-hidden="true" /> Clear local data…
              </button>
            )}
            <button className="primary-button settings-sign-out" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" /> Sign out
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
