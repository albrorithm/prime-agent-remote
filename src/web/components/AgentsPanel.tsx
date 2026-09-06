import { Archive, Bot, CircleAlert, Plus, RotateCcw, Search, Settings, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGateway } from "../gateway-store";
import { usePersistentDesktop } from "../hooks/usePersistentDesktop";
import { useSessionOrganization } from "../hooks/useSessionOrganization";
import { needsAttention, withAncestors } from "./agent-tree-utils";
import { AgentTree } from "./AgentTree";
import { NewSessionPanel } from "./NewSessionPanel";
import { SessionActions } from "./SessionActions";
import { SessionMenu } from "./SessionMenu";
import { SettingsPanel } from "./SettingsPanel";

/** The two state filters the summary counts open. Null is "everything". */
type StateFilter = "attention" | "working" | null;

interface AgentsPanelProps {
  visible?: boolean;
  onClose?: () => void;
  onNavigate?: () => void;
}

export function AgentsPanel({ visible, onClose, onNavigate }: AgentsPanelProps) {
  const { abort, attentionCount, catalog, selectedAgentId, selectAgent } = useGateway();
  const persistentDesktop = usePersistentDesktop();
  const organization = useSessionOrganization();
  const { archived, pinned } = organization;
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  // The row menu: which session, and the row control it opened from.
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  // Resolved from the catalog every render rather than held as a copy, so the
  // view reflects a rename (or a session going away) as it happens.
  const managed = catalog.agents.find((agent) => agent.id === manageId) ?? null;
  const menuAgent = catalog.agents.find((agent) => agent.id === menu?.id) ?? null;
  // Settings is a detour, not work in progress, so closing the drawer should
  // leave it. `creating` deliberately survives: it holds a chosen directory and
  // a typed name that would be destructive to discard behind a swipe.
  useEffect(() => {
    if (!visible) setSettingsOpen(false);
  }, [visible]);
  // Same reasoning for session actions, plus one more: it names one session,
  // and leaving it open would reopen it against whatever is selected later.
  useEffect(() => {
    if (!visible) setManageId(null);
  }, [visible]);
  // A session can leave the catalog while its actions are open.
  useEffect(() => {
    if (manageId && !managed) setManageId(null);
  }, [manageId, managed]);
  // The row menu is the same kind of state: it names one row, and the row
  // can go, or the drawer can close under it.
  useEffect(() => {
    if (menu && (!menuAgent || !visible)) setMenu(null);
  }, [menu, menuAgent, visible]);
  const closeMenu = useCallback(() => setMenu(null), []);
  // The panel is hidden (not unmounted) on mobile, so a search typed before
  // closing the drawer would otherwise survive to the next open and silently
  // filter sessions the user no longer remembers searching for. Reset only on
  // the visible->not-visible transition: this never fires while `visible`
  // stays true (e.g. persistentDesktop, where the panel is always visible and
  // must not clobber active typing).
  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);
  // Filters are the same kind of hidden state as a stale search: a drawer
  // reopened tomorrow showing three of eleven sessions, with the reason
  // scrolled off the top, is the shape this whole feature is meant to avoid.
  // The archived view resets with them for the same reason.
  useEffect(() => {
    if (!visible) {
      setStateFilter(null);
      setShowArchived(false);
    }
  }, [visible]);
  /* Archiving is a root-level decision, so a subagent's visibility is its
     root's. Reading `rootId` rather than walking parents keeps that true even
     for a row whose parent has not arrived yet. */
  const archivedRootCount = useMemo(
    () => catalog.agents.filter((agent) => agent.parentId === null && archived.has(agent.id)).length,
    [archived, catalog.agents],
  );
  /* Counts stay app-wide, deliberately: they are the same numbers the app
     badge shows, and a hidden session that needs an answer still needs one.
     A count that shrank when you archived something would let the drawer
     under-report work the user has not dealt with. */
  const workingCount = catalog.agents.filter((agent) => agent.activity === "working").length;

  const visibleAgents = useMemo(
    () => (showArchived ? catalog.agents : catalog.agents.filter((agent) => !archived.has(agent.rootId))),
    [archived, catalog.agents, showArchived],
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized && !stateFilter) return visibleAgents;
    const matched = new Set(
      visibleAgents
        .filter((agent) => !normalized || `${agent.name} ${agent.description ?? ""}`.toLowerCase().includes(normalized))
        .filter((agent) => !stateFilter
          || (stateFilter === "attention" ? needsAttention(agent) : agent.activity === "working"))
        .map((agent) => agent.id),
    );
    // Ancestors join after the two tests are combined, not between them: an
    // ancestor is there to make a match reachable, and one that had to pass
    // the filter itself would cut the branch it was added to hold up.
    const kept = withAncestors(visibleAgents, matched);
    return visibleAgents.filter((agent) => kept.has(agent.id));
  }, [query, stateFilter, visibleAgents]);

  const filtersActive = Boolean(stateFilter) || showArchived || Boolean(query.trim());
  function showAll() {
    setStateFilter(null);
    setShowArchived(false);
    setQuery("");
  }

  const navigate = (id: string) => {
    void selectAgent(id);
    onNavigate?.();
  };

  return (
    <section className="panel agents-panel" aria-label="Sessions">
      {!creating && !settingsOpen && !managed && (
        <header className="drawer-header">
          <div className="drawer-title">
            <img src="/prime-mark.svg" alt="" />
            <div><p className="eyebrow">Prime Agent</p><h1>Sessions</h1></div>
          </div>
          {/* On desktop the panel is permanent and its header is within reach, so
              both actions live there. On a phone they float at the bottom right
              instead, under the thumb; see the end of the list. */}
          {persistentDesktop && (
            <>
              <button className="icon-button" onClick={() => setCreating(true)} aria-label="Start a new session"><Plus /></button>
              <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings /></button>
            </>
          )}
          {onClose && <button className="icon-button drawer-close" onClick={onClose} aria-label="Close sessions"><X /></button>}
        </header>
      )}
      {settingsOpen ? (
        <SettingsPanel onClose={() => setSettingsOpen(false)} />
      ) : managed ? (
        <SessionActions
          agent={managed}
          onClose={() => setManageId(null)}
          pinned={pinned.has(managed.id)}
          archived={archived.has(managed.id)}
          onTogglePin={organization.togglePin}
          onToggleArchive={organization.toggleArchive}
          initialSection="controls"
        />
      ) : creating ? (
        <NewSessionPanel
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onNavigate?.();
          }}
        />
      ) : (
        <>
          <div className="summary-strip session-filters" aria-label="Filter sessions">
            <button
              type="button"
              className={`session-filter ${attentionCount ? "has-attention" : ""}`}
              aria-pressed={stateFilter === "attention"}
              onClick={() => setStateFilter((current) => (current === "attention" ? null : "attention"))}
            >
              <CircleAlert /> {attentionCount} attention
            </button>
            <button
              type="button"
              className="session-filter"
              aria-pressed={stateFilter === "working"}
              onClick={() => setStateFilter((current) => (current === "working" ? null : "working"))}
            >
              <Bot /> {workingCount} working
            </button>
            {archivedRootCount > 0 && (
              <button
                type="button"
                className="session-filter"
                aria-pressed={showArchived}
                onClick={() => setShowArchived((current) => !current)}
              >
                <Archive /> Archived {archivedRootCount}
              </button>
            )}
            {filtersActive && (
              <button type="button" className="session-filter session-filter-reset" onClick={showAll}>
                <RotateCcw /> Show all
              </button>
            )}
          </div>
          <label className="search-field">
            <Search aria-hidden="true" />
            <span className="sr-only">Search sessions and agents</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
          </label>
          <div className="panel-scroll">
            {filtered.length ? (
              <AgentTree
                agents={filtered}
                selectedId={selectedAgentId}
                onSelect={navigate}
                onAbort={abort}
                onManage={(id, anchor) => setMenu({ id, anchor })}
                drawerOpen={visible}
                pinned={pinned}
                archived={archived}
              />
            ) : (
              /* Never "no sessions": the sessions are all still there, and a
                 list that empties itself after a tap is the one way this
                 feature could read as having deleted something. The way back
                 is in the sentence. */
              <p className="empty-state">
                No sessions match.{" "}
                <button type="button" className="link-button" onClick={showAll}>Show all</button>
              </p>
            )}
          </div>
          {menu && menuAgent && (
            <SessionMenu
              agent={menuAgent}
              anchor={menu.anchor}
              onClose={closeMenu}
              onOpenControls={setManageId}
              pinned={pinned.has(menuAgent.id)}
              archived={archived.has(menuAgent.id)}
              onTogglePin={organization.togglePin}
              onToggleArchive={organization.toggleArchive}
            />
          )}
          {!persistentDesktop && (
            <div className="drawer-fabs">
              <button className="settings-fab" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
                <Settings />
              </button>
              <button className="new-session-fab" onClick={() => setCreating(true)} aria-label="Start a new session">
                <Plus />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
