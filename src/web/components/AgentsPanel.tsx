import { Bot, CircleAlert, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useGateway } from "../gateway-store";
import { usePersistentDesktop } from "../hooks/usePersistentDesktop";
import { AgentTree } from "./AgentTree";
import { NewSessionPanel } from "./NewSessionPanel";

interface AgentsPanelProps {
  visible?: boolean;
  onClose?: () => void;
  onNavigate?: () => void;
}

export function AgentsPanel({ visible, onClose, onNavigate }: AgentsPanelProps) {
  const { abort, catalog, selectedAgentId, selectAgent } = useGateway();
  const persistentDesktop = usePersistentDesktop();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return catalog.agents;
    const matches = new Set(
      catalog.agents
        .filter((agent) => `${agent.name} ${agent.description ?? ""}`.toLowerCase().includes(normalized))
        .map((agent) => agent.id),
    );
    for (const agent of catalog.agents) {
      if (matches.has(agent.id)) {
        let parent = agent.parentId;
        while (parent) {
          matches.add(parent);
          parent = catalog.agents.find((item) => item.id === parent)?.parentId ?? null;
        }
      }
    }
    return catalog.agents.filter((agent) => matches.has(agent.id));
  }, [catalog.agents, query]);
  const attentionCount = catalog.agents.filter((agent) => agent.attention).length;
  const workingCount = catalog.agents.filter((agent) => agent.activity === "working").length;

  const navigate = (id: string) => {
    void selectAgent(id);
    onNavigate?.();
  };

  return (
    <section className="panel agents-panel" aria-label="Sessions">
      {!creating && (
        <header className="drawer-header">
          <div className="drawer-title">
            <img src="/prime-mark.svg" alt="" />
            <div><p className="eyebrow">Prime Agent</p><h1>Sessions</h1></div>
          </div>
          {persistentDesktop && (
            <button className="icon-button" onClick={() => setCreating(true)} aria-label="Start a new session"><Plus /></button>
          )}
          {onClose && <button className="icon-button drawer-close" onClick={onClose} aria-label="Close sessions"><X /></button>}
        </header>
      )}
      {creating ? (
        <NewSessionPanel
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onNavigate?.();
          }}
        />
      ) : (
        <>
          <div className="summary-strip" aria-label="Agent summary">
            <span className={attentionCount ? "has-attention" : ""}><CircleAlert /> {attentionCount} attention</span>
            <span><Bot /> {workingCount} working</span>
          </div>
          <label className="search-field">
            <Search aria-hidden="true" />
            <span className="sr-only">Search sessions and agents</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
          </label>
          <div className="panel-scroll">
            {filtered.length ? (
              <AgentTree agents={filtered} selectedId={selectedAgentId} onSelect={navigate} onAbort={abort} drawerOpen={visible} />
            ) : (
              <p className="empty-state">No sessions match that search.</p>
            )}
          </div>
          {!persistentDesktop && (
            <button className="new-session-fab" onClick={() => setCreating(true)} aria-label="Start a new session">
              <Plus />
            </button>
          )}
        </>
      )}
    </section>
  );
}
