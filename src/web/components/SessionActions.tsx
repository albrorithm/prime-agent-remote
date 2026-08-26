import { LoaderCircle, Power, SlidersHorizontal, Trash2, X } from "lucide-react";
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
  return agent.capabilities.rename || agent.capabilities.stop || agent.capabilities.delete;
}

/**
 * Session management, as a drawer sub-view rather than more controls on the
 * tree row. The row is already a single tap that opens a session, and these
 * are the operations you would least like to trigger by mistake while reaching
 * for that.
 */
export function SessionActions({ agent, onClose }: SessionActionsProps) {
  const { deleteSession, rename, stop } = useGateway();
  const [name, setName] = useState(agent.name);
  const [renaming, setRenaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  const trimmed = name.trim();
  const renameReady = agent.capabilities.rename && Boolean(trimmed) && trimmed !== agent.name && !renaming;
  // Typed, not tapped. Delete is the one operation here that destroys
  // something, and it sits in a view whose other controls are single taps —
  // so confirming it has to be an act you could not perform by accident.
  const deleteReady = agent.capabilities.delete && confirmName.trim() === agent.name && !deleting;

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

  async function submitStop() {
    if (!agent.capabilities.stop || stopping) return;
    setStopping(true);
    try {
      await stop(agent.id);
      onClose();
    } catch {
      // The gateway store surfaces the error. Staying open lets the user see
      // the session's new state rather than guessing whether it ended.
      setStopping(false);
    }
  }

  async function submitDelete() {
    if (!deleteReady) return;
    setDeleting(true);
    try {
      await deleteSession(agent.id, agent.name);
      onClose();
    } catch {
      // The gateway store surfaces the error. Nothing was deleted, so the
      // typed confirmation is cleared rather than left primed.
      setConfirmName("");
      setDeleting(false);
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
        {agent.capabilities.stop && (
          <section className="session-action-group" aria-labelledby="session-stop-heading">
            <h3 id="session-stop-heading">End the session</h3>
            <p className="session-action-note">
              Stops the running session and leaves it saved. You can resume it later by sending a message — nothing is deleted.
            </p>
            <button className="secondary-button" disabled={stopping} onClick={() => void submitStop()}>
              {stopping ? <LoaderCircle className="spin" aria-hidden="true" /> : <Power aria-hidden="true" />}
              {stopping ? "Ending session…" : "End session"}
            </button>
          </section>
        )}
        {agent.capabilities.delete && (
          <section className="session-action-group danger" aria-labelledby="session-delete-heading">
            <h3 id="session-delete-heading">Delete this session</h3>
            <p className="session-action-note">
              Deletes the session and its whole transcript from this machine. This cannot be undone
              and there is no copy to restore from.
            </p>
            <p className="session-action-note">
              Type <strong>{agent.name}</strong> to confirm.
            </p>
            <input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              aria-label="Type the session name to confirm deletion"
              autoComplete="off"
              maxLength={MAX_SESSION_NAME_CHARS}
            />
            <button className="danger-button" disabled={!deleteReady} onClick={() => void submitDelete()}>
              {deleting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              {deleting ? "Deleting…" : "Delete permanently"}
            </button>
          </section>
        )}
      </div>
    </section>
  );
}
