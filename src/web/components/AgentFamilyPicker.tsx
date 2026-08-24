import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { createPortal } from "react-dom";
import type { AgentSummary } from "../../protocol";
import {
  buildVisibleAgentDescendants,
  collectAgentDescendants,
  indexChildren,
  type AgentFamilyRow,
} from "./agent-tree-utils";

interface AgentFamilyPickerProps {
  agents: AgentSummary[];
  selectedAgent: AgentSummary;
  onSelect: (id: string) => void;
}

interface PickerMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below";
}

interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function readSafeAreaInsets(): SafeAreaInsets {
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "visibility:hidden",
    "pointer-events:none",
    "padding-top:env(safe-area-inset-top, 0px)",
    "padding-right:env(safe-area-inset-right, 0px)",
    "padding-bottom:env(safe-area-inset-bottom, 0px)",
    "padding-left:env(safe-area-inset-left, 0px)",
  ].join(";");
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

function measurePickerMenu(trigger: HTMLButtonElement): PickerMenuPosition {
  const margin = 8;
  const gap = 6;
  const rect = trigger.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const safeArea = readSafeAreaInsets();
  const leftEdge = viewportLeft + safeArea.left + margin;
  const rightEdge = Math.max(leftEdge + 1, viewportLeft + viewportWidth - safeArea.right - margin);
  const topEdge = viewportTop + safeArea.top + margin;
  const bottomEdge = Math.max(topEdge + 1, viewportTop + viewportHeight - safeArea.bottom - margin);
  const width = Math.min(220, rightEdge - leftEdge);
  const left = Math.min(Math.max(leftEdge, rect.right - width), rightEdge - width);
  const belowTop = Math.max(topEdge, rect.bottom + gap);
  const aboveTop = Math.min(bottomEdge, rect.top - gap);
  const availableBelow = Math.max(0, bottomEdge - belowTop);
  const availableAbove = Math.max(0, aboveTop - topEdge);
  const placement = availableBelow >= 180 || availableBelow >= availableAbove ? "below" : "above";
  return {
    top: placement === "below" ? belowTop : aboveTop,
    left,
    width,
    maxHeight: Math.max(1, Math.min(320, placement === "below" ? availableBelow : availableAbove)),
    placement,
  };
}

function activityLabel(agent: AgentSummary): "Active" | "Idle" {
  return agent.activity === "working" || agent.lifecycle === "starting" ? "Active" : "Idle";
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AgentFamilyPicker({ agents, selectedAgent, onSelect }: AgentFamilyPickerProps) {
  const descendants = useMemo(
    () => collectAgentDescendants(agents, selectedAgent.id),
    [agents, selectedAgent.id],
  );
  const childrenByParent = useMemo(() => indexChildren(agents), [agents]);
  const descendantIds = useMemo(() => new Set(descendants.map((agent) => agent.id)), [descendants]);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<PickerMenuPosition | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const menuId = useId();
  const visible = useMemo(
    () => buildVisibleAgentDescendants(agents, selectedAgent.id, expanded),
    [agents, selectedAgent.id, expanded],
  );
  const workingCount = descendants.filter((agent) => agent.activity === "working").length;
  const countLabel = `${descendants.length} subagent${descendants.length === 1 ? "" : "s"}`;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setExpanded(new Set());
    setFocusId(null);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open || (focusId && visible.some((row) => row.agent.id === focusId))) return;
    const firstId = visible[0]?.agent.id ?? null;
    setFocusId(firstId);
    queueMicrotask(() => {
      if (firstId) rowRefs.current.get(firstId)?.focus();
      else menuRef.current?.focus();
    });
  }, [open, visible, focusId]);

  useEffect(() => {
    if (!open) return;
    const outsideMenu = (target: EventTarget | null) => target instanceof Node
      && !menuRef.current?.contains(target)
      && !triggerRef.current?.contains(target);
    const focusFromTrigger = (backward: boolean) => {
      const items = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((item) => item.offsetParent !== null && !menuRef.current?.contains(item));
      const triggerIndex = triggerRef.current ? items.indexOf(triggerRef.current) : -1;
      const target = backward ? items[triggerIndex - 1] : items[triggerIndex + 1];
      close();
      queueMicrotask(() => (target ?? triggerRef.current)?.focus());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Tab" && menuRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        focusFromTrigger(event.shiftKey);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (outsideMenu(event.target)) close();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (outsideMenu(event.target)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (triggerRef.current) setMenuPosition(measurePickerMenu(triggerRef.current));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, descendants.length, workingCount, selectedAgent.id]);

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

  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    if (triggerRef.current) setMenuPosition(measurePickerMenu(triggerRef.current));
    setOpen(true);
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
          aria-controls={open ? menuId : undefined}
          aria-label={`Open ${countLabel} of ${selectedAgent.name}${workingCount ? `, ${workingCount} working` : ""}`}
          onClick={toggleOpen}
        >
          {workingCount > 0 ? <span className="lineage-forward-working" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
          <span>{descendants.length}</span>
          <span className="lineage-forward-label">subagent{descendants.length === 1 ? "" : "s"}</span>
          <ChevronDown className="lineage-forward-chevron" aria-hidden="true" />
        </button>
      </span>

      {open && menuPosition && createPortal(
        <div className="family-picker-layer" data-gesture-exclusion>
          <section
            className="family-picker-menu"
            id={menuId}
            ref={menuRef}
            role="dialog"
            aria-label="Subagents"
            tabIndex={-1}
            data-placement={menuPosition.placement}
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
              width: menuPosition.width,
              maxHeight: menuPosition.maxHeight,
              transform: menuPosition.placement === "above" ? "translateY(-100%)" : undefined,
              transformOrigin: menuPosition.placement === "above" ? "bottom center" : "top center",
            }}
          >
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
                      aria-label={`${row.agent.name}, ${activityLabel(row.agent)}${children.length ? `, ${children.length} direct subagent${children.length === 1 ? "" : "s"}` : ""}`}
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
                      <span className="family-agent-copy">
                        <strong title={row.agent.name}>{row.agent.name}</strong>
                        <small>{activityLabel(row.agent)}</small>
                      </span>
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
