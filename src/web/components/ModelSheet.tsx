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
  /** Whether the full model list is open. Stays open through a pick, on purpose: the
   * catalog reload that follows moves the check mark without collapsing the list under it. */
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const modelLabelId = `${titleId}-model`;
  const effortLabelId = `${titleId}-effort`;
  const allModelsListId = `${titleId}-all-models`;
  const models = optionsFor(catalog, "model");
  const efforts = optionsFor(catalog, "effort");
  // Prime's own scoped shortlist, plus the current model even when it fell out of
  // scope: the check mark that answers "what is this session on" must always be
  // visible without opening the full list.
  const primaryModels = models.filter((option) => option.scoped || option.current);

  useEffect(() => {
    // The sheet portals beside the app root, so `aria-modal` alone would leave
    // the composer behind the scrim reachable by Tab and by a screen reader's
    // swipe. Same shape as ImageViewer: the root goes inert for the sheet's
    // lifetime, and focus goes back where it came from when the sheet closes.
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const rootWasInert = appRoot?.hasAttribute("inert") ?? false;
    appRoot?.setAttribute("inert", "");
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (!rootWasInert) appRoot?.removeAttribute("inert");
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
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

  function modelRow(option: SlashCommandOption) {
    return (
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
    );
  }

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

        {primaryModels.length > 0 && (
          <div className="model-sheet-section">
            <p className="model-sheet-label" id={modelLabelId}>Model</p>
            <div className="model-sheet-models" role="radiogroup" aria-labelledby={modelLabelId}>
              {primaryModels.map((option) => modelRow(option))}
            </div>
          </div>
        )}

        {models.length > 0 && (
          <div className="model-sheet-section">
            <button
              type="button"
              className="model-sheet-expander"
              aria-expanded={modelsExpanded}
              aria-controls={allModelsListId}
              onClick={() => setModelsExpanded((expanded) => !expanded)}
            >
              All models · {models.length}
            </button>
            {modelsExpanded && (
              <div className="model-sheet-all-models" id={allModelsListId}>
                <div className="model-sheet-models" role="radiogroup" aria-label="All models">
                  {models.map((option) => modelRow(option))}
                </div>
              </div>
            )}
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
