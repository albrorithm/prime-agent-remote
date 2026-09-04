import { Ban, CheckCircle2, CircleAlert, CircleDashed, Clock3, LoaderCircle, Moon, X } from "lucide-react";
import type {
  RefineStatus,
  SessionContextUsage,
  SessionDashboard as SessionDashboardData,
  SessionDashboardChild,
  SessionDashboardChildStatus,
  SessionDashboardStatus,
} from "../../protocol";
import { useGateway } from "../gateway-store";
import type { AgentStatusTone } from "./agent-status";
import { formatCoarseDuration } from "../duration";

// The dashboard is the surface for what the transcript cannot show: overall
// session status, context/token usage, real per-child stats, an advisory
// needs-input flag, and refine history. Nothing here duplicates a transcript
// row, the header pill, or the sessions list.

const STATUS_LABEL: Record<SessionDashboardStatus, string> = {
  responding: "Responding",
  compacting: "Compacting context",
  running_command: "Running a command",
  idle: "Idle",
  inactive: "Inactive",
};

const STATUS_TONE: Record<SessionDashboardStatus, AgentStatusTone> = {
  responding: "working",
  compacting: "working",
  running_command: "working",
  idle: "idle",
  inactive: "inactive",
};

const CHILD_LABEL: Record<SessionDashboardChildStatus, string> = {
  queued: "Queued",
  running: "Working",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function contextPercent(usage?: SessionContextUsage): number | undefined {
  if (!usage) return undefined;
  const raw = usage.percent
    ?? (usage.tokens !== undefined && usage.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : undefined);
  if (raw === undefined || Number.isNaN(raw)) return undefined;
  return Math.min(100, Math.max(0, raw));
}

function childMeta(child: SessionDashboardChild): string {
  const parts = [CHILD_LABEL[child.status]];
  if (child.status === "running" && child.toolName) parts.push(`using ${child.toolName}`);
  if (child.durationMs !== undefined) parts.push(formatCoarseDuration(child.durationMs / 1000));
  if (child.toolUseCount !== undefined) parts.push(`${child.toolUseCount} tool${child.toolUseCount === 1 ? "" : "s"}`);
  if (child.tokenCount !== undefined) parts.push(`${child.tokenCount.toLocaleString()} tokens`);
  return parts.join(" · ");
}

function StatusGlyph({ tone }: { tone: AgentStatusTone }) {
  if (tone === "working") return <LoaderCircle className="dashboard-glyph working spin" aria-hidden="true" />;
  if (tone === "inactive") return <Moon className="dashboard-glyph" aria-hidden="true" />;
  return <CheckCircle2 className="dashboard-glyph" aria-hidden="true" />;
}

function ChildGlyph({ status }: { status: SessionDashboardChildStatus }) {
  switch (status) {
    case "queued":
      return <Clock3 className="dashboard-glyph" aria-hidden="true" />;
    case "running":
      return <LoaderCircle className="dashboard-glyph working spin" aria-hidden="true" />;
    case "done":
      return <CheckCircle2 className="dashboard-glyph" aria-hidden="true" />;
    case "error":
      return <CircleAlert className="dashboard-glyph failed" aria-hidden="true" />;
    case "cancelled":
      return <Ban className="dashboard-glyph" aria-hidden="true" />;
    default:
      return <CircleDashed className="dashboard-glyph" aria-hidden="true" />;
  }
}

function RefineGlyph({ status }: { status: RefineStatus }) {
  if (status === "running") return <LoaderCircle className="dashboard-glyph working spin" aria-hidden="true" />;
  if (status === "failed") return <CircleAlert className="dashboard-glyph failed" aria-hidden="true" />;
  return <CheckCircle2 className="dashboard-glyph" aria-hidden="true" />;
}

function ChildRow({ child, onOpen }: { child: SessionDashboardChild; onOpen: (agentId: string) => void }) {
  const body = (
    <>
      <ChildGlyph status={child.status} />
      <span className="dashboard-child-copy">
        <strong>{child.name}</strong>
        <small>{childMeta(child)}</small>
        {(child.answerPreview || child.recap) && (
          <small className="dashboard-child-preview">{child.answerPreview ?? child.recap}</small>
        )}
        {child.error && <small className="dashboard-child-error">{child.error}</small>}
      </span>
    </>
  );
  if (!child.agentId) {
    return <div className="dashboard-child dashboard-child-static">{body}</div>;
  }
  return (
    <button className="dashboard-child" onClick={() => onOpen(child.agentId!)}>
      {body}
    </button>
  );
}

interface SessionDashboardProps {
  onClose?: () => void;
  onNavigate?: () => void;
}

export function SessionDashboard({ onClose, onNavigate }: SessionDashboardProps) {
  const { selectedAgent, selectedSnapshot, selectAgent } = useGateway();
  const dashboard = selectedSnapshot?.dashboard;

  const openChild = (agentId: string) => {
    void selectAgent(agentId);
    onNavigate?.();
  };

  return (
    <section className="panel session-dashboard" aria-labelledby="dashboard-heading">
      <header className="drawer-header">
        <div>
          <p className="eyebrow">{selectedAgent?.name ?? "No agent"}</p>
          <h2 id="dashboard-heading">Session dashboard</h2>
        </div>
        {onClose && (
          <button className="icon-button drawer-close" onClick={onClose} aria-label="Close session dashboard">
            <X />
          </button>
        )}
      </header>
      <div className="panel-scroll dashboard-scroll">
        {!selectedSnapshot ? (
          <div className="loading-state">
            <LoaderCircle className="spin" /> Loading dashboard…
          </div>
        ) : !dashboard ? (
          <p className="empty-state">No dashboard data for this session.</p>
        ) : (
          <DashboardBody dashboard={dashboard} onOpenChild={openChild} />
        )}
      </div>
    </section>
  );
}

function DashboardBody({
  dashboard,
  onOpenChild,
}: {
  dashboard: SessionDashboardData;
  onOpenChild: (agentId: string) => void;
}) {
  const percent = contextPercent(dashboard.contextUsage);
  const tone = STATUS_TONE[dashboard.status];

  return (
    <>
      <section className={`dashboard-status-card ${tone}`}>
        <StatusGlyph tone={tone} />
        <span className="dashboard-status-copy">
          <small>Status</small>
          <strong>{STATUS_LABEL[dashboard.status]}</strong>
        </span>
      </section>
      {dashboard.recap && <p className="dashboard-recap">{dashboard.recap}</p>}

      {dashboard.needsInput && (
        <div className="dashboard-badge dashboard-badge-attention" role="note">
          <CircleAlert aria-hidden="true" />
          <span>
            <strong>May need input</strong>
            <small>Background guess, not a task queue</small>
          </span>
        </div>
      )}

      {percent !== undefined && (
        <div className="goal-progress dashboard-context">
          <span>Context used</span>
          <strong>{Math.round(percent)}%</strong>
          <div
            role="progressbar"
            aria-label="Context window used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          {dashboard.contextUsage?.tokens !== undefined && dashboard.contextUsage?.contextWindow !== undefined && (
            <small className="dashboard-context-tokens">
              {Math.trunc(dashboard.contextUsage.tokens).toLocaleString()} / {Math.trunc(dashboard.contextUsage.contextWindow).toLocaleString()} tokens
            </small>
          )}
        </div>
      )}

      {dashboard.children.length > 0 && (
        <section className="dashboard-section dashboard-children" aria-labelledby="dashboard-children-heading">
          <h3 id="dashboard-children-heading">Subagents</h3>
          {dashboard.children.map((child) => (
            <ChildRow key={child.id} child={child} onOpen={onOpenChild} />
          ))}
        </section>
      )}

      {dashboard.refines.length > 0 && (
        <section className="dashboard-section dashboard-refines" aria-labelledby="dashboard-refines-heading">
          <h3 id="dashboard-refines-heading">Refine history</h3>
          <ol>
            {dashboard.refines.map((refine) => (
              <li key={refine.id} className={refine.status}>
                <RefineGlyph status={refine.status} />
                <span className="dashboard-refine-copy">
                  <strong>{refine.summary}</strong>
                  {(refine.scope || refine.rollback) && (
                    <small>
                      {refine.scope}
                      {refine.scope && refine.rollback ? " · " : ""}
                      {refine.rollback ? "Rollback" : ""}
                    </small>
                  )}
                </span>
                <time dateTime={refine.createdAt}>{formatClock(refine.createdAt)}</time>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
