import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight, CircleAlert, GitBranch, LoaderCircle, Moon, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { AgentSummary } from "../../protocol";

interface AgentFamilyPickerProps {
  agents: AgentSummary[];
  selectedAgent: AgentSummary;
  onSelect: (id: string) => void;
}

export interface AgentFamilyRow {
  agent: AgentSummary;
  level: number;
}

function agentPriority(agent: AgentSummary): number {
  if (agent.attention) return 0;
  if (agent.activity === "working") return 1;
  if (agent.lifecycle === "inactive") return 3;
  return 2;
}

function indexChildren(agents: AgentSummary[]): Map<string, AgentSummary[]> {
  const children = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    if (!agent.parentId) continue;
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => agentPriority(a) - agentPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
  }
  return children;
}

export function collectAgentDescendants(agents: AgentSummary[], parentId: string): AgentSummary[] {
  const children = indexChildren(agents);
  const descendants: AgentSummary[] = [];
  const seen = new Set<string>([parentId]);
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      visit(child.id);
    }
  };
  visit(parentId);
  return descendants;
}

export function buildVisibleAgentDescendants(
  agents: AgentSummary[],
  parentId: string,
  expanded: ReadonlySet<string>,
): AgentFamilyRow[] {
  const children = indexChildren(agents);
  const visible: AgentFamilyRow[] = [];
  const seen = new Set<string>([parentId]);
  const visit = (id: string, level: number) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      visible.push({ agent: child, level });
      if (expanded.has(child.id)) visit(child.id, level + 1);
    }
  };
  visit(parentId, 1);
  return visible;
}

function stateLabel(agent: AgentSummary): string {
  if (agent.attention) return `Needs ${agent.attention}`;
  if (agent.lifecycle === "failed") return "Failed";
  if (agent.lifecycle === "stopped") return "Stopped";
  if (agent.lifecycle === "inactive") return "Inactive";
  if (agent.lifecycle === "starting") return "Starting";
  if (agent.activity === "working") return "Working";
  if (agent.activity === "blocked") return "Blocked";
  return "Idle";
}

function StateIcon({ agent }: { agent: AgentSummary }) {
  if (agent.attention || agent.lifecycle === "failed") {
    return <CircleAlert className="family-agent-state attention" aria-hidden="true" />;
  }
  if (agent.activity === "working" || agent.lifecycle === "starting") {
    return <LoaderCircle className="family-agent-state working spin" aria-hidden="true" />;
  }
  if (agent.lifecycle === "inactive" || agent.lifecycle === "stopped") {
    return <Moon className="family-agent-state" aria-hidden="true" />;
  }
  return <span className="family-agent-state-dot" aria-hidden="true" />;
}

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AgentFamilyPicker({ agents, selectedAgent, onSelect }: AgentFamilyPickerProps) {
  const descendants = useMemo(
    () => collectAgentDescendants(agents, selectedAgent.id),
    [agents, selectedAgent.id],
  );
  const childrenByParent = useMemo(() => indexChildren(agents), [agents]);
  const descendantIds = useMemo(() => new Set(descendants.map((agent) => agent.id)), [descendants]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const headingId = useId();
  const visible = useMemo(
    () => buildVisibleAgentDescendants(agents, selectedAgent.id, expanded),
    [agents, selectedAgent.id, expanded],
  );
  const workingCount = descendants.filter((agent) => agent.activity === "working").length;
  const countLabel = `${descendants.length} subagent${descendants.length === 1 ? "" : "s"}`;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setExpanded(new Set());
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open || (focusId && visible.some((row) => row.agent.id === focusId))) return;
    const firstId = visible[0]?.agent.id ?? null;
    setFocusId(firstId);
    queueMicrotask(() => {
      if (firstId) rowRefs.current.get(firstId)?.focus();
      else sheetRef.current?.focus();
    });
  }, [open, visible, focusId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        .filter((item) => item.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!descendants.length && open) close();
  }, [descendants.length, open]);

  if (!descendants.length) return null;

  const move = (nextId: string | undefined) => {
    if (!nextId) return;
    setFocusId(nextId);
    queueMicrotask(() => rowRefs.current.get(nextId)?.focus());
  };

  const toggle = (id: string, force?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      const shouldExpand = force ?? !next.has(id);
      if (shouldExpand) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const navigableChildren = (id: string) => (childrenByParent.get(id) ?? [])
    .filter((child) => descendantIds.has(child.id));

  const select = (id: string) => {
    onSelect(id);
    close();
    queueMicrotask(() => document.getElementById("transcript-heading")?.focus());
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, row: AgentFamilyRow) => {
    if (event.target !== event.currentTarget) return;
    const index = visible.findIndex((item) => item.agent.id === row.agent.id);
    const children = navigableChildren(row.agent.id);
    if (event.key === "ArrowDown") move(visible[index + 1]?.agent.id);
    else if (event.key === "ArrowUp") move(visible[index - 1]?.agent.id);
    else if (event.key === "Home") move(visible[0]?.agent.id);
    else if (event.key === "End") move(visible.at(-1)?.agent.id);
    else if (event.key === "ArrowRight" && children.length) {
      if (!expanded.has(row.agent.id)) toggle(row.agent.id, true);
      else move(children[0]?.id);
    } else if (event.key === "ArrowLeft") {
      if (expanded.has(row.agent.id)) toggle(row.agent.id, false);
      else if (row.agent.parentId !== selectedAgent.id) move(row.agent.parentId ?? undefined);
    } else if (event.key === "Enter" || event.key === " ") select(row.agent.id);
    else return;
    event.preventDefault();
  };

  return (
    <>
      <span className="lineage-item lineage-forward">
        <ChevronRight className="lineage-separator" aria-hidden="true" />
        <button
          ref={triggerRef}
          className="lineage-forward-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Open ${countLabel} of ${selectedAgent.name}${workingCount ? `, ${workingCount} working` : ""}`}
          onClick={() => setOpen((current) => !current)}
        >
          {workingCount > 0 ? <span className="lineage-forward-working" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
          <span>{descendants.length}</span>
          <span className="lineage-forward-label">subagent{descendants.length === 1 ? "" : "s"}</span>
          <ChevronDown className="lineage-forward-chevron" aria-hidden="true" />
        </button>
      </span>

      {open && createPortal(
        <div className="family-picker-layer" data-gesture-exclusion>
          <div className="family-picker-scrim" aria-hidden="true" onClick={() => close(true)} />
          <section
            className="family-picker-sheet"
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            tabIndex={-1}
          >
            <header className="family-picker-header">
              <div>
                <p className="eyebrow" title={selectedAgent.name}>{selectedAgent.name}</p>
                <h2 id={headingId}>Subagents</h2>
              </div>
              <span className="family-picker-summary">{countLabel}{workingCount ? ` · ${workingCount} working` : ""}</span>
              <button className="icon-button" type="button" onClick={() => close(true)} aria-label="Close subagent picker"><X /></button>
            </header>
            <div className="family-picker-scroll">
              <div className="family-picker-tree" role="tree" aria-label={`Subagents of ${selectedAgent.name}`}>
                {visible.map((row, index) => {
                  const children = navigableChildren(row.agent.id);
                  const isExpanded = expanded.has(row.agent.id);
                  return (
                    <div
                      key={row.agent.id}
                      ref={(node) => {
                        if (node) rowRefs.current.set(row.agent.id, node);
                        else rowRefs.current.delete(row.agent.id);
                      }}
                      className="family-agent-row"
                      role="treeitem"
                      aria-level={row.level}
                      aria-expanded={children.length ? isExpanded : undefined}
                      aria-label={`${row.agent.name}, ${stateLabel(row.agent)}${children.length ? `, ${children.length} direct subagent${children.length === 1 ? "" : "s"}` : ""}`}
                      tabIndex={focusId === row.agent.id || (!focusId && index === 0) ? 0 : -1}
                      style={{ "--family-depth": row.level - 1 } as CSSProperties}
                      onFocus={() => setFocusId(row.agent.id)}
                      onKeyDown={(event) => onRowKeyDown(event, row)}
                      onClick={() => select(row.agent.id)}
                    >
                      {children.length ? (
                        <button
                          className="family-disclosure"
                          type="button"
                          tabIndex={-1}
                          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.agent.name} subagents`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(row.agent.id);
                          }}
                        >
                          {isExpanded ? <ChevronDown /> : <ChevronRight />}
                        </button>
                      ) : <span className="family-disclosure-space" />}
                      <StateIcon agent={row.agent} />
                      <span className="family-agent-copy">
                        <strong>{row.agent.name}</strong>
                        <small>{stateLabel(row.agent)}</small>
                      </span>
                      {row.agent.unreadCount > 0 && (
                        <span className="family-agent-unread" aria-label={`${row.agent.unreadCount} unread`}>
                          {row.agent.unreadCount > 99 ? "99+" : row.agent.unreadCount}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
