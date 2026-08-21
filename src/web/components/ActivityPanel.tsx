import { CheckCircle2, CircleAlert, GitBranch, LoaderCircle, Wrench, X } from "lucide-react";
import { useGateway } from "../gateway-store";

function Icon({ kind, status }: { kind: string; status: string }) {
  if (status === "failed" || status === "waiting") return <CircleAlert aria-hidden="true" />;
  if (status === "running") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (kind === "child") return <GitBranch aria-hidden="true" />;
  if (kind === "tool") return <Wrench aria-hidden="true" />;
  return <CheckCircle2 aria-hidden="true" />;
}

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
                <span><strong>{child.name}</strong><small>{child.attention ? `Needs ${child.attention}` : child.activity}</small></span>
              </button>
            ))}
          </section>
        )}
        {!selectedSnapshot ? (
          <div className="loading-state"><LoaderCircle className="spin" /> Loading activity…</div>
        ) : selectedSnapshot.activity.length ? (
          <ol className="activity-list">
            {selectedSnapshot.activity.map((item) => (
              <li key={item.id} className={item.status}>
                <span className="activity-icon"><Icon kind={item.kind} status={item.status} /></span>
                <span><strong>{item.title}</strong>{item.detail && <small className="activity-detail">{item.detail}</small>}</span>
                <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-state">No recent activity for this agent.</p>
        )}
      </div>
    </section>
  );
}
