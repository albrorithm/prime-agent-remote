import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, CircleAlert, LoaderCircle, Moon, Square } from "lucide-react";
import type { AgentSummary } from "../../protocol";
import { agentStatus } from "./agent-status";
import { buildVisibleAgents } from "./agent-tree-utils";

interface Props {
  agents: AgentSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAbort?: (id: string) => Promise<void>;
  drawerOpen?: boolean;
}

export function directoryLeaf(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? null;
}

function subtitle(agent: AgentSummary): string {
  return directoryLeaf(agent.cwd) || agent.description || agentStatus(agent).label;
}

function StateIcon({ agent }: { agent: AgentSummary }) {
  const status = agentStatus(agent);
  if (status.tone === "attention" || status.tone === "failed") {
    return <CircleAlert className="agent-state attention" aria-hidden="true" />;
  }
  if (status.tone === "working" || status.tone === "starting") {
    return <LoaderCircle className="agent-state working spin" aria-hidden="true" />;
  }
  if (status.tone === "inactive" || status.tone === "stopped") {
    return <Moon className="agent-state" aria-hidden="true" />;
  }
  return <span className="agent-state-dot" aria-hidden="true" />;
}

export function AgentTree({ agents, selectedId, onSelect, onAbort, drawerOpen }: Props) {
  const roots = agents.filter((agent) => agent.parentId === null).map((agent) => agent.id);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(agents.map((item) => item.id)));
  const [focusId, setFocusId] = useState<string | null>(selectedId ?? roots[0] ?? null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
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
  const rovingFocusId = visible.some((item) => item.id === focusId)
    ? focusId
    : visible.find((item) => item.id === selectedId)?.id ?? visible[0]?.id ?? null;
  const focusedTreeItemWasRemoved = typeof document !== "undefined"
    && focusId !== null
    && rovingFocusId !== focusId
    && itemRefs.current.get(focusId) === document.activeElement;

  useLayoutEffect(() => {
    if (focusId === rovingFocusId) return;
    setFocusId(rovingFocusId);
    if (focusedTreeItemWasRemoved && rovingFocusId) {
      queueMicrotask(() => itemRefs.current.get(rovingFocusId)?.focus());
    }
  }, [focusId, focusedTreeItemWasRemoved, rovingFocusId]);

  useEffect(() => {
    if (selectedId) setFocusId(selectedId);
  }, [selectedId]);

  const knownRoots = useRef<Set<string>>(new Set(roots));
  useEffect(() => {
    const fresh = agents.filter((item) => item.parentId === null && !knownRoots.current.has(item.id));
    if (!fresh.length) return;
    for (const item of fresh) knownRoots.current.add(item.id);
    setExpanded((current) => {
      const next = new Set(current);
      for (const item of fresh) next.add(item.id);
      return next;
    });
  }, [agents]);

  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || lastSelected.current === selectedId) return;
    lastSelected.current = selectedId;
    const byId = new Map(agents.map((item) => [item.id, item]));
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      let cursor = byId.get(selectedId)?.parentId ?? null;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        if (!next.has(cursor)) {
          next.add(cursor);
          changed = true;
        }
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      return changed ? next : current;
    });
  }, [agents, selectedId]);

  useEffect(() => {
    if (!selectedId || !drawerOpen) return;
    const node = itemRefs.current.get(selectedId);
    try {
      node?.scrollIntoView({ block: "center" });
    } catch {
      // scrollIntoView is unavailable in some environments (jsdom); centering is best-effort.
    }
  }, [selectedId, drawerOpen]);

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

  async function stopAgent(id: string): Promise<void> {
    if (!onAbort || stoppingIds.has(id)) return;
    setStoppingIds((current) => new Set(current).add(id));
    try {
      await onAbort(id);
    } catch {
      // The gateway store exposes the error while the row becomes available for retry.
    } finally {
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
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
            tabIndex={rovingFocusId === agent.id || (!rovingFocusId && index === 0) ? 0 : -1}
            className={`agent-row ${selectedId === agent.id ? "selected" : ""}`}
            style={{ "--tree-depth": agent.depth } as React.CSSProperties}
            onFocus={() => setFocusId(agent.id)}
            onKeyDown={(event) => onKeyDown(event, agent)}
            onClick={() => onSelect(agent.id)}
          >
            <span className="tree-indent" aria-hidden="true" />
            {children.length > 0 && (
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
            )}
            <StateIcon agent={agent} />
            <span className="agent-copy">
              <strong>{agent.name}</strong>
              <span>{subtitle(agent)}</span>
            </span>
            {agent.unreadCount > 0 && selectedId !== agent.id && (
              <span className="tree-unread" aria-label={`${agent.unreadCount} unread`}>
                {agent.unreadCount > 99 ? "99+" : agent.unreadCount}
              </span>
            )}
            <span className={`state-pill ${["attention", "failed"].includes(agentStatus(agent).tone) ? "attention" : ""}`}>{agentStatus(agent).label}</span>
            {onAbort && agent.activity !== "idle" && agent.capabilities.abort && (
              <button
                className="row-stop"
                aria-label={`${stoppingIds.has(agent.id) ? "Stopping" : "Stop"} ${agent.name}`}
                aria-busy={stoppingIds.has(agent.id)}
                disabled={stoppingIds.has(agent.id)}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void stopAgent(agent.id);
                }}
              >
                <Square aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
