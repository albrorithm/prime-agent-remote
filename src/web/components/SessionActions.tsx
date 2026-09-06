import { Archive, ArchiveRestore, LoaderCircle, Pin, PinOff, Power, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentSummary, SlashCommandResult } from "../../protocol";
import { MAX_SESSION_NAME_CHARS } from "../../protocol";
import { useGateway } from "../gateway-store";

type HeartbeatResult = Extract<SlashCommandResult, { kind: "heartbeat" }>;

interface SessionActionsProps {
  agent: AgentSummary;
  onClose: () => void;
  /** Device-local organization state, owned by useSessionOrganization. Absent when a caller offers no organizing. */
  pinned?: boolean;
  archived?: boolean;
  onTogglePin?: (id: string) => void;
  onToggleArchive?: (id: string) => void;
  /** Where to land: the row menu opens this view for the controls it cannot hold. */
  initialSection?: "controls";
}

const HEARTBEAT_STATUS_LABELS: Record<HeartbeatResult["status"], string> = {
  none: "No heartbeat set",
  active: "Running",
  paused: "Paused",
  completed: "Finished",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/** How long an "Applied" tick stays up. Long enough to read, short enough not to look like state. */
const APPLIED_CONFIRMATION_MS = 2_500;

/**
 * Whether a session has any management action to offer. One rule, shared by
 * the tree row that opens this view and the view itself, so a row can never
 * lead somewhere with nothing on it.
 */
export function hasSessionActions(agent: AgentSummary): boolean {
  // A root always has something on offer now: pinning and archiving are this
  // device's own bookkeeping and need no capability from the daemon, so the
  // manage button on a root row can never open an empty view.
  return agent.parentId === null
    || agent.capabilities.rename
    || agent.capabilities.stop
    || agent.capabilities.delete;
}

/**
 * Session management, as a drawer sub-view rather than more controls on the
 * tree row. The row is already a single tap that opens a session, and these
 * are the operations you would least like to trigger by mistake while reaching
 * for that.
 */
export function SessionActions({
  agent,
  onClose,
  pinned = false,
  archived = false,
  onTogglePin,
  onToggleArchive,
  initialSection,
}: SessionActionsProps) {
  const { deleteSession, rename, runSlashCommand, selectedAgentId, selectedSnapshot, stop } = useGateway();
  const controlsHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (initialSection !== "controls") return;
    try {
      controlsHeadingRef.current?.scrollIntoView({ block: "start" });
    } catch {
      // Unavailable in some environments (jsdom); landing at the top is fine.
    }
  }, [initialSection]);
  const [name, setName] = useState(agent.name);
  const [renaming, setRenaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const trimmed = name.trim();
  const renameReady = agent.capabilities.rename && Boolean(trimmed) && trimmed !== agent.name && !renaming;
  // Delete is the one operation here that destroys something, in a view whose
  // other controls are single taps, so it takes a second deliberate one. It used
  // to take the session's name, typed — which is a lot of phone keyboard to ask
  // for, and no safer than naming the session on the button and offering a way
  // out. This is the same reveal-then-confirm shape the settings panel uses for
  // clearing local data.
  const deleteReady = agent.capabilities.delete && !deleting;

  // Only roots are organized: a subagent's place in the list is its root's, so
  // pinning one would promise something the tree cannot honour.
  const organizable = agent.parentId === null && Boolean(onTogglePin && onToggleArchive);

  /* The session commands act on the SELECTED agent, always. `runSlashCommand`
     has no agent parameter and reads the store's selection, so offering these
     against a session the user is merely managing would quietly steer a
     different conversation. Hence: shown, disabled, and told why. */
  const controlsAvailable = agent.parentId === null && agent.lifecycle === "live";
  const controlsEnabled = controlsAvailable && selectedAgentId === agent.id;
  const goal = controlsEnabled ? selectedSnapshot?.goal : undefined;

  const [objective, setObjective] = useState("");
  const [pendingControl, setPendingControl] = useState<string | null>(null);
  const [appliedControl, setAppliedControl] = useState<string | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatResult | null>(null);
  const [heartbeatUnavailable, setHeartbeatUnavailable] = useState(false);

  useEffect(() => {
    if (!appliedControl) return;
    const timer = setTimeout(() => setAppliedControl(null), APPLIED_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [appliedControl]);

  /* Read the schedule as the group appears rather than behind a button: a
     Heartbeat row that says nothing until you press something is a row you
     have to poke to find out it is empty. The read is a `status` argument,
     which changes nothing. A failure still raises the store's banner, so the
     inline line only has to say why this row is blank. */
  useEffect(() => {
    if (!controlsEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await runSlashCommand("heartbeat", "status");
        if (!cancelled && result.kind === "heartbeat") setHeartbeat(result);
      } catch {
        if (!cancelled) setHeartbeatUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controlsEnabled, runSlashCommand]);

  async function runControl(key: string, command: string, args: string): Promise<void> {
    if (!controlsEnabled || pendingControl) return;
    setPendingControl(key);
    try {
      const result = await runSlashCommand(command, args);
      if (result.kind === "heartbeat") setHeartbeat(result);
      setAppliedControl(key);
      if (key === "goal-objective") setObjective("");
    } catch {
      // The store raises its own banner for a failed command, and there is
      // nothing to confirm, so this leaves the row exactly as it was.
    } finally {
      setPendingControl(null);
    }
  }

  function controlLabel(key: string, label: string) {
    return pendingControl === key ? <><LoaderCircle className="spin" aria-hidden="true" />{label}</> : label;
  }

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
      // The gateway store surfaces the error. Nothing was deleted, so this
      // disarms rather than staying primed for a stray tap. One error is now
      // reachable without any staleness: the gateway checks the name it was
      // given against the session's current one, and a name derived from the
      // first message can change under a session that has never been named.
      setConfirmingDelete(false);
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
        {organizable && (
          <section className="session-action-group" aria-labelledby="session-organize-heading">
            <h3 id="session-organize-heading">In your list</h3>
            <p className="session-action-note">
              How this session sits in your list on this device. Prime Agent is never told, and nothing here
              starts or stops any work.
            </p>
            <button className="secondary-button" onClick={() => onTogglePin?.(agent.id)}>
              {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {pinned ? "Unpin" : "Pin"}
            </button>
            <p className="session-action-note">Kept at the top of the list.</p>
            <button className="secondary-button" onClick={() => onToggleArchive?.(agent.id)}>
              {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
              {archived ? "Unarchive" : "Archive"}
            </button>
            <p className="session-action-note">Hidden from the list; nothing is stopped.</p>
          </section>
        )}
        {controlsAvailable && (
          <section className="session-action-group session-controls" aria-labelledby="session-controls-heading">
            <h3 id="session-controls-heading" ref={controlsHeadingRef}>Controls</h3>
            {!controlsEnabled && (
              <p className="session-action-note">Open this session to change it.</p>
            )}

            <div className="session-control-row">
              <h4>Goal</h4>
              {controlsEnabled ? (
                goal
                  ? <p className="session-control-state"><strong>{goal.objective}</strong> <span>{goal.status}</span></p>
                  : <p className="session-control-state">No goal set.</p>
              ) : (
                <p className="session-control-state">Open the session to see its goal.</p>
              )}
              <div className="session-control-buttons">
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("goal-pause", "goal", "pause")}>
                  {controlLabel("goal-pause", "Pause")}
                </button>
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("goal-resume", "goal", "resume")}>
                  {controlLabel("goal-resume", "Resume")}
                </button>
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("goal-clear", "goal", "clear")}>
                  {controlLabel("goal-clear", "Clear")}
                </button>
              </div>
              {/* The command takes the objective as its whole argument, so the
                  field sends exactly what was typed and nothing around it. */}
              <input
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && objective.trim()) void runControl("goal-objective", "goal", objective.trim());
                }}
                disabled={!controlsEnabled}
                aria-label="Set a goal objective"
                placeholder="Set an objective"
              />
              <button
                className="secondary-button"
                disabled={!controlsEnabled || !objective.trim() || Boolean(pendingControl)}
                onClick={() => void runControl("goal-objective", "goal", objective.trim())}
              >
                {controlLabel("goal-objective", "Set objective")}
              </button>
              {appliedControl?.startsWith("goal") && <p className="session-control-applied" role="status">Applied</p>}
            </div>

            <div className="session-control-row">
              <h4>Autonomous mode</h4>
              {/* Two buttons rather than a switch on purpose: the command's
                  result carries no autonomous state, so a switch would have to
                  invent a position and would show the wrong one until someone
                  pressed it. */}
              <p className="session-control-state">Prime Agent does not report this back, so this sets it rather than showing it.</p>
              <div className="session-control-buttons">
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("autonomous-on", "autonomous", "on")}>
                  {controlLabel("autonomous-on", "Turn on")}
                </button>
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("autonomous-off", "autonomous", "off")}>
                  {controlLabel("autonomous-off", "Turn off")}
                </button>
              </div>
              {appliedControl?.startsWith("autonomous") && <p className="session-control-applied" role="status">Applied</p>}
            </div>

            <div className="session-control-row">
              <h4>Heartbeat</h4>
              {controlsEnabled ? (
                heartbeat ? (
                  <p className="session-control-state">
                    <strong>{HEARTBEAT_STATUS_LABELS[heartbeat.status]}</strong>
                    {heartbeat.schedule ? ` ${heartbeat.schedule}` : ""}
                    {heartbeat.nextRunAt ? `, next ${heartbeat.nextRunAt}` : ""}
                  </p>
                ) : (
                  <p className="session-control-state">{heartbeatUnavailable ? "Schedule unavailable." : "Reading the schedule…"}</p>
                )
              ) : (
                <p className="session-control-state">Open the session to see its schedule.</p>
              )}
              <div className="session-control-buttons">
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("heartbeat-pause", "heartbeat", "pause")}>
                  {controlLabel("heartbeat-pause", "Pause")}
                </button>
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("heartbeat-resume", "heartbeat", "resume")}>
                  {controlLabel("heartbeat-resume", "Resume")}
                </button>
                <button className="secondary-button" disabled={!controlsEnabled || Boolean(pendingControl)} onClick={() => void runControl("heartbeat-clear", "heartbeat", "clear")}>
                  {controlLabel("heartbeat-clear", "Clear")}
                </button>
              </div>
              {appliedControl?.startsWith("heartbeat") && <p className="session-control-applied" role="status">Applied</p>}
            </div>
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
            {confirmingDelete ? (
              <>
                {/* Naming the session on the confirmation step is what the typed
                    name was really for: knowing which one is about to go. */}
                <p className="session-action-note">
                  Deleting <strong>{agent.name}</strong>.
                </p>
                <button className="danger-button" disabled={!deleteReady} onClick={() => void submitDelete()}>
                  {deleting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {deleting ? "Deleting…" : "Delete permanently"}
                </button>
                <button className="secondary-button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="secondary-button" onClick={() => setConfirmingDelete(true)}>
                <Trash2 aria-hidden="true" /> Delete permanently…
              </button>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
