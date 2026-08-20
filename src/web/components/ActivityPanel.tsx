import { CheckCircle2, CircleAlert, GitBranch, LoaderCircle, Wrench } from "lucide-react";
import { useGateway } from "../gateway-store";

function Icon({ kind, status }: { kind: string; status: string }) {
  if (status === "failed" || status === "waiting") return <CircleAlert aria-hidden="true" />;
  if (status === "running") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (kind === "child") return <GitBranch aria-hidden="true" />;
  if (kind === "tool") return <Wrench aria-hidden="true" />;
  return <CheckCircle2 aria-hidden="true" />;
}

export function ActivityPanel() {
  const { selectedAgent, selectedSnapshot, catalog, selectAgent } = useGateway();
  const children = selectedAgent ? catalog.agents.filter((agent) => agent.parentId === selectedAgent.id) : [];
  return (
    <section className="panel activity-panel" aria-labelledby="activity-heading">
      <header className="panel-header">
        <div>
          <p className="eyebrow">{selectedAgent?.name ?? "No agent"}</p>
          <h2 id="activity-heading">Activity</h2>
        </div>
      </header>
      <div className="panel-scroll activity-scroll">
        {children.length > 0 && (
          <section className="child-summary" aria-labelledby="children-heading">
            <h3 id="children-heading">Subagents</h3>
            {children.map((child) => (
              <button key={child.id} onClick={() => void selectAgent(child.id)}>
                <GitBranch aria-hidden="true" />
                <span><strong>{child.name}</strong><small>{child.attention ? `Needs ${child.attention}` : child.activity}</small></span>
              </button>
            ))}
          </section>
        )}
        <ol className="activity-list">
          {selectedSnapshot?.activity.map((item) => (
            <li key={item.id} className={item.status}>
              <span className="activity-icon"><Icon kind={item.kind} status={item.status} /></span>
              <span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </li>
          ))}
        </ol>
        {!selectedSnapshot?.activity.length && <p className="empty-state">No activity for this agent.</p>}
      </div>
    </section>
  );
}
