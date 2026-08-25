import { CheckCircle2, CircleAlert, GitBranch, LoaderCircle, X } from "lucide-react";
import type { SessionDashboard } from "../../protocol";
import { useGateway } from "../gateway-store";
import { agentStatus } from "./agent-status";

// Interim rendering until SessionDashboard gets its own component (WS5): a
// status line plus the refine history, all sourced from snapshot.dashboard.
const DASHBOARD_STATUS_LABELS: Record<SessionDashboard["status"], string> = {
  responding: "Responding",
  compacting: "Compacting context",
  running_command: "Running a command",
  idle: "Idle",
  inactive: "Inactive",
};

interface ActivityPanelProps {
  onClose?: () => void;
  onNavigate?: () => void;
}

export function ActivityPanel({ onClose, onNavigate }: ActivityPanelProps) {
  const { selectedAgent, selectedSnapshot, catalog, selectAgent } = useGateway();
  const children = selectedAgent ? catalog.agents.filter((agent) => agent.parentId === selectedAgent.id) : [];
  const navigate = (id: string) => {
    void selectAgent(id);
    onNavigate?.();
  };
  return (
    <section className="panel activity-panel" aria-labelledby="activity-heading">
      <header className="drawer-header">
        <div>
          <p className="eyebrow">{selectedAgent?.name ?? "No agent"}</p>
          <h2 id="activity-heading">Activity</h2>
        </div>
        {onClose && <button className="icon-button drawer-close" onClick={onClose} aria-label="Close activity"><X /></button>}
      </header>
      <div className="panel-scroll activity-scroll">
        {children.length > 0 && (
          <section className="child-summary" aria-labelledby="children-heading">
            <h3 id="children-heading">Subagents</h3>
            {children.map((child) => (
              <button key={child.id} onClick={() => navigate(child.id)}>
                <GitBranch aria-hidden="true" />
                <span><strong>{child.name}</strong><small>{agentStatus(child).label}</small></span>
              </button>
            ))}
          </section>
        )}
        {!selectedSnapshot ? (
          <div className="loading-state"><LoaderCircle className="spin" /> Loading activity…</div>
        ) : selectedSnapshot.dashboard ? (
          <ol className="activity-list">
            <li className={selectedSnapshot.dashboard.status === "idle" || selectedSnapshot.dashboard.status === "inactive" ? "complete" : "running"}>
              <span className="activity-icon">
                {selectedSnapshot.dashboard.status === "idle" || selectedSnapshot.dashboard.status === "inactive"
                  ? <CheckCircle2 aria-hidden="true" />
                  : <LoaderCircle className="spin" aria-hidden="true" />}
              </span>
              <span>
                <strong>{DASHBOARD_STATUS_LABELS[selectedSnapshot.dashboard.status]}</strong>
                {selectedSnapshot.dashboard.recap && <small className="activity-detail">{selectedSnapshot.dashboard.recap}</small>}
              </span>
            </li>
            {selectedSnapshot.dashboard.needsInput && (
              <li className="waiting">
                <span className="activity-icon"><CircleAlert aria-hidden="true" /></span>
                <span><strong>May need input</strong></span>
              </li>
            )}
            {selectedSnapshot.dashboard.refines.map((refine) => (
              <li key={refine.id} className={refine.status === "failed" ? "failed" : refine.status === "running" ? "running" : "complete"}>
                <span className="activity-icon">
                  {refine.status === "failed"
                    ? <CircleAlert aria-hidden="true" />
                    : refine.status === "running"
                      ? <LoaderCircle className="spin" aria-hidden="true" />
                      : <CheckCircle2 aria-hidden="true" />}
                </span>
                <span><strong>Refine</strong><small className="activity-detail">{refine.summary}</small></span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-state">No session details for this agent.</p>
        )}
      </div>
    </section>
  );
}
