import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, CircleAlert, GitBranch, LoaderCircle, Moon } from "lucide-react";
import type { AgentSummary } from "../../protocol";

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function stateLabel(agent: AgentSummary): string {
  if (agent.attention) return `Needs ${agent.attention}`;
  if (agent.lifecycle === "inactive") return "Inactive";
  if (agent.activity === "working") return "Working";
  if (agent.activity === "blocked") return "Blocked";
  return "Idle";
}

function StateIcon({ agent }: { agent: AgentSummary }) {
  if (agent.attention) return <CircleAlert className="agent-state attention" aria-hidden="true" />;
  if (agent.activity === "working") return <LoaderCircle className="agent-state working spin" aria-hidden="true" />;
  if (agent.lifecycle === "inactive") return <Moon className="agent-state" aria-hidden="true" />;
  return <span className="agent-state-dot" aria-hidden="true" />;
}

export function buildVisibleAgents(agents: AgentSummary[], expanded: Set<string>): AgentSummary[] {
  const byParent = new Map<string | null, AgentSummary[]>();
  for (const item of agents) {
    const list = byParent.get(item.parentId) ?? [];
    list.push(item);
    byParent.set(item.parentId, list);
  }
  const priority = (item: AgentSummary) => (item.attention ? 0 : item.activity === "working" ? 1 : item.lifecycle === "inactive" ? 3 : 2);
  for (const list of byParent.values()) list.sort((a, b) => priority(a) - priority(b) || b.updatedAt.localeCompare(a.updatedAt));

  const output: AgentSummary[] = [];
  const seen = new Set<string>();
  const visit = (item: AgentSummary) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    output.push(item);
    if (expanded.has(item.id)) for (const child of byParent.get(item.id) ?? []) visit(child);
  };
  for (const root of byParent.get(null) ?? []) visit(root);
  for (const orphan of agents) if (!seen.has(orphan.id)) visit(orphan);
  return output;
}

export function AgentTree({ agents, selectedId, onSelect }: Props) {
  const roots = agents.filter((agent) => agent.parentId === null).map((agent) => agent.id);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(roots));
  const [focusId, setFocusId] = useState<string | null>(selectedId ?? roots[0] ?? null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const visible = useMemo(() => buildVisibleAgents(agents, expanded), [agents, expanded]);
  const childrenByParent = useMemo(() => {
    const result = new Map<string, AgentSummary[]>();
    for (const item of agents) {
      if (!item.parentId) continue;
      const list = result.get(item.parentId) ?? [];
      list.push(item);
      result.set(item.parentId, list);
    }
    return result;
  }, [agents]);

  useEffect(() => {
    if (selectedId) setFocusId(selectedId);
  }, [selectedId]);

  function move(nextId: string | undefined) {
    if (!nextId) return;
    setFocusId(nextId);
    queueMicrotask(() => itemRefs.current.get(nextId)?.focus());
  }

  function toggle(id: string, force?: boolean) {
    setExpanded((current) => {
      const next = new Set(current);
      const shouldExpand = force ?? !next.has(id);
      if (shouldExpand) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, agent: AgentSummary) {
    const index = visible.findIndex((item) => item.id === agent.id);
    const hasChildren = (childrenByParent.get(agent.id)?.length ?? 0) > 0;
    if (event.key === "ArrowDown") move(visible[index + 1]?.id);
    else if (event.key === "ArrowUp") move(visible[index - 1]?.id);
    else if (event.key === "Home") move(visible[0]?.id);
    else if (event.key === "End") move(visible.at(-1)?.id);
    else if (event.key === "ArrowRight" && hasChildren) {
      if (!expanded.has(agent.id)) toggle(agent.id, true);
      else move(childrenByParent.get(agent.id)?.[0]?.id);
    } else if (event.key === "ArrowLeft") {
      if (expanded.has(agent.id)) toggle(agent.id, false);
      else move(agent.parentId ?? undefined);
    } else if (event.key === "Enter" || event.key === " ") onSelect(agent.id);
    else return;
    event.preventDefault();
  }

  return (
    <div className="agent-tree" role="tree" aria-label="Agents">
      {visible.map((agent, index) => {
        const children = childrenByParent.get(agent.id) ?? [];
        const siblingList = agent.parentId ? childrenByParent.get(agent.parentId) ?? [] : agents.filter((item) => item.parentId === null);
        return (
          <div
            key={agent.id}
            ref={(node) => {
              if (node) itemRefs.current.set(agent.id, node);
              else itemRefs.current.delete(agent.id);
            }}
            role="treeitem"
            aria-level={agent.depth + 1}
            aria-selected={selectedId === agent.id}
            aria-expanded={children.length ? expanded.has(agent.id) : undefined}
            aria-setsize={siblingList.length}
            aria-posinset={Math.max(1, siblingList.findIndex((item) => item.id === agent.id) + 1)}
            tabIndex={focusId === agent.id || (!focusId && index === 0) ? 0 : -1}
            className={`agent-row ${selectedId === agent.id ? "selected" : ""}`}
            style={{ "--tree-depth": agent.depth } as React.CSSProperties}
            onFocus={() => setFocusId(agent.id)}
            onKeyDown={(event) => onKeyDown(event, agent)}
            onClick={() => onSelect(agent.id)}
          >
            <span className="tree-indent" aria-hidden="true" />
            {children.length > 0 ? (
              <button
                className="disclosure"
                tabIndex={-1}
                aria-label={`${expanded.has(agent.id) ? "Collapse" : "Expand"} ${agent.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(agent.id);
                }}
              >
                {expanded.has(agent.id) ? <ChevronDown /> : <ChevronRight />}
              </button>
            ) : (
              <span className="disclosure-placeholder"><GitBranch aria-hidden="true" /></span>
            )}
            <StateIcon agent={agent} />
            <span className="agent-copy">
              <strong>{agent.name}</strong>
              <span>{agent.description || stateLabel(agent)}</span>
            </span>
            <span className={`state-pill ${agent.attention ? "attention" : ""}`}>{stateLabel(agent)}</span>
          </div>
        );
      })}
    </div>
  );
}
