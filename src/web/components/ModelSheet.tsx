import { Check, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SlashCommandCatalog, SlashCommandOption } from "../../protocol";
import { useGateway } from "../gateway-store";

/** The options a command offers, or none when the session cannot run it. */
function optionsFor(catalog: SlashCommandCatalog, name: string): SlashCommandOption[] {
  const entry = catalog.commands.find((command) => command.name === name);
  return entry?.availability === "available" ? entry.options ?? [] : [];
}

export interface ModelSheetProps {
  agentId: string;
  catalog: SlashCommandCatalog;
  /** Hands back a freshly loaded catalog so the current marks move with the choice. */
  onCatalogChange: (catalog: SlashCommandCatalog) => void;
  onClose: () => void;
}

/**
 * Model and thinking level for the session, as a bottom sheet.
 *
 * Both lists are the adapter's own `/model` and `/effort` catalogs rather than
 * anything this app knows about models, and picking a row runs that command.
 * Which row is current is the catalog's answer too, so a successful pick is
 * followed by asking for the catalog again: nothing here guesses what the
 * session became.
 */
export function ModelSheet({ agentId, catalog, onCatalogChange, onClose }: ModelSheetProps) {
  const { runSlashCommand, loadSlashCommands } = useGateway();
  /** The `kind:value` being applied, so exactly one row can say so. */
  const [applying, setApplying] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const modelLabelId = `${titleId}-model`;
  const effortLabelId = `${titleId}-effort`;
  const models = optionsFor(catalog, "model");
  const efforts = optionsFor(catalog, "effort");

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    // On the document rather than the dialog: a tap leaves focus on the row
    // that was tapped, and on iOS often nowhere at all, so a handler bound to
    // the dialog would miss the key in exactly the case someone reaches for it.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function apply(kind: "model" | "effort", value: string) {
    if (applying) return;
    setApplying(`${kind}:${value}`);
    try {
      await runSlashCommand(kind, value);
      if (typeof loadSlashCommands === "function") {
        const next = await loadSlashCommands(agentId);
        if (next.agentId === agentId) onCatalogChange(next);
      }
    } catch {
      // The gateway store raises its own banner for a failed command. The sheet
      // stays open: closing it would take away the thing the message is about.
    } finally {
      setApplying(null);
    }
  }

  return createPortal(
    <div
      className="model-sheet-scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="model-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-gesture-exclusion>
        <div className="model-sheet-head">
          <h2 id={titleId}>Model and effort</h2>
          <button
            ref={closeRef}
            type="button"
            className="model-sheet-close"
            aria-label="Close"
            onClick={onClose}
          ><X aria-hidden="true" /></button>
        </div>

        {models.length > 0 && (
          <div className="model-sheet-section">
            <p className="model-sheet-label" id={modelLabelId}>Model</p>
            <div className="model-sheet-models" role="radiogroup" aria-labelledby={modelLabelId}>
              {models.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  className="model-sheet-row"
                  aria-checked={Boolean(option.current)}
                  aria-disabled={applying !== null}
                  onClick={() => void apply("model", option.value)}
                >
                  <span className="model-sheet-row-label">{option.label}</span>
                  {applying === `model:${option.value}`
                    ? <small>Applying…</small>
                    : option.current ? <Check aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          </div>
        )}

        {efforts.length > 0 && (
          <div className="model-sheet-section">
            <p className="model-sheet-label" id={effortLabelId}>Thinking level</p>
            <div className="model-sheet-efforts" role="radiogroup" aria-labelledby={effortLabelId}>
              {efforts.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  className="model-sheet-chip"
                  // The visible text swaps to "Applying…" because a chip this
                  // size cannot hold both. The name must not move with it.
                  aria-label={option.label}
                  aria-checked={Boolean(option.current)}
                  aria-disabled={applying !== null}
                  onClick={() => void apply("effort", option.value)}
                >{applying === `effort:${option.value}` ? "Applying…" : option.label}</button>
              ))}
            </div>
          </div>
        )}

        {!models.length && !efforts.length && (
          <p className="model-sheet-empty">This session does not offer a model or thinking level.</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
