import { Bot, CircleAlert, Plus, Search, Settings, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useGateway } from "../gateway-store";
import { usePersistentDesktop } from "../hooks/usePersistentDesktop";
import { AgentTree } from "./AgentTree";
import { NewSessionPanel } from "./NewSessionPanel";
import { SessionActions } from "./SessionActions";
import { SettingsPanel } from "./SettingsPanel";

interface AgentsPanelProps {
  visible?: boolean;
  onClose?: () => void;
  onNavigate?: () => void;
}

export function AgentsPanel({ visible, onClose, onNavigate }: AgentsPanelProps) {
  const { abort, attentionCount, catalog, selectedAgentId, selectAgent } = useGateway();
  const persistentDesktop = usePersistentDesktop();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  // Resolved from the catalog every render rather than held as a copy, so the
  // view reflects a rename (or a session going away) as it happens.
  const managed = catalog.agents.find((agent) => agent.id === manageId) ?? null;
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
  // The panel is hidden (not unmounted) on mobile, so a search typed before
  // closing the drawer would otherwise survive to the next open and silently
  // filter sessions the user no longer remembers searching for. Reset only on
  // the visible->not-visible transition: this never fires while `visible`
  // stays true (e.g. persistentDesktop, where the panel is always visible and
  // must not clobber active typing).
  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);
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
  const workingCount = catalog.agents.filter((agent) => agent.activity === "working").length;

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
          {persistentDesktop && (
            <button className="icon-button" onClick={() => setCreating(true)} aria-label="Start a new session"><Plus /></button>
          )}
          {/* Deliberately not `.drawer-close`: that class hides at ≥1100px, but settings
              must stay reachable on desktop, where this panel is permanent. */}
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings /></button>
          {onClose && <button className="icon-button drawer-close" onClick={onClose} aria-label="Close sessions"><X /></button>}
        </header>
      )}
      {settingsOpen ? (
        <SettingsPanel onClose={() => setSettingsOpen(false)} />
      ) : managed ? (
        <SessionActions agent={managed} onClose={() => setManageId(null)} />
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
              <AgentTree agents={filtered} selectedId={selectedAgentId} onSelect={navigate} onAbort={abort} onManage={setManageId} drawerOpen={visible} />
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
