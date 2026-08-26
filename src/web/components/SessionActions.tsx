import { LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import type { AgentSummary } from "../../protocol";
import { MAX_SESSION_NAME_CHARS } from "../../protocol";
import { useGateway } from "../gateway-store";

interface SessionActionsProps {
  agent: AgentSummary;
  onClose: () => void;
}

/**
 * Whether a session has any management action to offer. One rule, shared by
 * the tree row that opens this view and the view itself, so a row can never
 * lead somewhere with nothing on it.
 */
export function hasSessionActions(agent: AgentSummary): boolean {
  return agent.capabilities.rename;
}

/**
 * Session management, as a drawer sub-view rather than more controls on the
 * tree row. The row is already a single tap that opens a session, and these
 * are the operations you would least like to trigger by mistake while reaching
 * for that.
 */
export function SessionActions({ agent, onClose }: SessionActionsProps) {
  const { rename } = useGateway();
  const [name, setName] = useState(agent.name);
  const [renaming, setRenaming] = useState(false);

  const trimmed = name.trim();
  const renameReady = agent.capabilities.rename && Boolean(trimmed) && trimmed !== agent.name && !renaming;

  async function submitRename() {
    if (!renameReady) return;
    setRenaming(true);
    try {
      await rename(agent.id, trimmed);
      onClose();
    } catch {
      // The gateway store surfaces the error; the view stays open so the
      // typed name is not lost along with the failure.
      setRenaming(false);
    }
  }

  return (
    <section className="panel session-actions" aria-labelledby="session-actions-heading">
      <header className="drawer-header">
        <div className="drawer-title">
          <SlidersHorizontal aria-hidden="true" />
          <div>
            <p className="eyebrow">Session</p>
            <h2 id="session-actions-heading">{agent.name}</h2>
          </div>
        </div>
        {/* Deliberately not `.drawer-close`: that class hides at ≥1100px, where
            the Sessions panel is permanent but this sub-view still needs a way
            back out. */}
        <button className="icon-button" onClick={onClose} aria-label="Close session actions"><X /></button>
      </header>

      <div className="panel-scroll session-actions-scroll" data-gesture-exclusion>
        {agent.capabilities.rename && (
          <section className="session-action-group" aria-labelledby="session-rename-heading">
            <h3 id="session-rename-heading">Name</h3>
            <p className="session-action-note">What this session is called everywhere — here, and in Prime Agent itself.</p>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitRename();
              }}
              aria-label="Session name"
              maxLength={MAX_SESSION_NAME_CHARS}
            />
            <button className="primary-button" disabled={!renameReady} onClick={() => void submitRename()}>
              {renaming && <LoaderCircle className="spin" aria-hidden="true" />}
              Rename session
            </button>
          </section>
        )}
      </div>
    </section>
  );
}
