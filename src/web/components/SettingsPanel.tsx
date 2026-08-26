import { LogOut, Settings as SettingsIcon, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PROTOCOL_VERSION } from "../../protocol";
import { useGateway } from "../gateway-store";
import { DRAFTS_KEY } from "../hooks/useComposerDrafts";
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
