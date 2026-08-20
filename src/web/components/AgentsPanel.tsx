import { Bot, CircleAlert, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useGateway } from "../gateway-store";
import { AgentTree } from "./AgentTree";

export function AgentsPanel() {
  const { catalog, selectedAgentId, selectAgent } = useGateway();
  const [query, setQuery] = useState("");
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

  return (
    <section className="panel agents-panel" aria-labelledby="agents-heading">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Prime Agent</p>
          <h1 id="agents-heading">Agents</h1>
        </div>
        <div className="agent-count" aria-label={`${catalog.agents.length} agents`}><Bot />{catalog.agents.length}</div>
      </header>
      <div className="summary-strip" aria-label="Agent summary">
        <span className={attentionCount ? "has-attention" : ""}><CircleAlert /> {attentionCount} need attention</span>
        <span>{workingCount} working</span>
      </div>
      <label className="search-field">
        <Search aria-hidden="true" />
        <span className="sr-only">Search agents</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" />
      </label>
      <div className="panel-scroll">
        {filtered.length ? (
          <AgentTree agents={filtered} selectedId={selectedAgentId} onSelect={(id) => void selectAgent(id)} />
        ) : (
          <p className="empty-state">No agents match that search.</p>
        )}
      </div>
    </section>
  );
}
