import { Check, ChevronDown, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import type { RefineEditAction, RefineEditKind, RefineEditSummary, TranscriptPresentation } from "../../protocol";

export type RefinePresentation = Extract<TranscriptPresentation, { kind: "refine" }>;

const KIND_LABELS: Record<RefineEditKind, string> = {
  prompt: "Prompt",
  memory: "Memory",
  skill: "Skill",
  subagent: "Subagent",
};

const ACTION_LABELS: Record<RefineEditAction, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
};

function RefineStatusIcon({ status }: { status: RefinePresentation["status"] }) {
  if (status === "running") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (status === "failed") return <CircleAlert aria-hidden="true" />;
  return <Check aria-hidden="true" />;
}

function editLine(edit: RefineEditSummary): string {
  const action = ACTION_LABELS[edit.action];
  const kind = KIND_LABELS[edit.kind];
  return edit.title ? `${action} ${kind.toLowerCase()} — ${edit.title}` : `${action} ${kind.toLowerCase()}`;
}

/**
 * Renders a `refine` transcript row: the continual harness editing itself
 * (prompt/memory/skill/subagent entries). Deliberately system-flavored, not a
 * chat bubble — this is the app narrating its own maintenance, not a message
 * from the agent or the user.
 */
export function RefineRow({ presentation }: { presentation: RefinePresentation }) {
  const { status, summary, scope, rollback, edits, error } = presentation;
  const editCount = edits?.length ?? 0;

  const ariaLabelParts = [
    `Refine ${status}`,
    summary,
    scope ? `${scope} scope` : null,
    rollback ? "rollback" : null,
  ].filter(Boolean);
  const ariaLabel = ariaLabelParts.join(", ");

  const header = (
    <>
      <RefineStatusIcon status={status} />
      <strong className="refine-title">{status === "running" ? "Refining…" : "Refine"}</strong>
      <span className="refine-summary-text">{summary}</span>
      {scope && <span className={`refine-scope-chip ${scope}`}>{scope}</span>}
      {rollback && (
        <span className="refine-rollback-badge">
          <RotateCcw aria-hidden="true" />
          Rollback
        </span>
      )}
    </>
  );

  return (
    <div className={`refine-row ${status}`} data-gesture-exclusion>
      {editCount > 0 ? (
        <details>
          <summary aria-label={`${ariaLabel}, ${editCount} edit${editCount === 1 ? "" : "s"}`}>
            {header}
            <span className="refine-edit-count">{editCount} edit{editCount === 1 ? "" : "s"}</span>
            <ChevronDown className="refine-chevron" aria-hidden="true" />
          </summary>
          <ul className="refine-edits">
            {edits!.map((edit, index) => (
              <li className="refine-edit" key={index}>
                <span className="refine-edit-title">{editLine(edit)}</span>
                {edit.reason && <span className="refine-edit-reason">{edit.reason}</span>}
                {edit.error && <span className="refine-edit-error">{edit.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="refine-header-row" role="group" aria-label={ariaLabel}>
          {header}
        </div>
      )}
      {status === "failed" && error && <p className="refine-error">{error}</p>}
    </div>
  );
}
