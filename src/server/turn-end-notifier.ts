import type { AgentSummary, CatalogSnapshot } from "../protocol.js";

/**
 * Deciding when an agent has actually finished, as opposed to merely paused.
 *
 * Prime Agent does not end a turn cleanly. The root finishes, and then over the
 * next minute or two a straggling subagent posts its report and wakes the
 * session again for a few seconds at a time. Every one of those is a
 * working→idle transition, and notifying on each would mean three or four
 * buzzes for one piece of news — which is how a notification becomes something
 * people swipe away without reading.
 *
 * So a turn is over when the agent has been idle CONTINUOUSLY for
 * `quietMs`. Any return to work restarts that clock, however brief, so a
 * straggler postpones the notification rather than adding one.
 *
 * That alone would still notify twice for one turn: after the notification
 * fires, the next straggler settles again and looks like a fresh completion.
 * Hence the arming. A notification is owed only when something has actually
 * asked the agent for work, and it is owed once:
 *
 *   - the gateway arms an agent when it forwards a message to it, or when the
 *     user answers an attention request from the phone (which resumes a turn);
 *   - an agent that has been working continuously for `resumeMs` arms itself,
 *     which covers a turn started from the terminal rather than the app;
 *   - firing disarms it.
 *
 * A three-second straggler reaches neither condition, so it cannot re-arm. Work
 * that runs long enough to pass `resumeMs` can, and that is intended: a
 * subagent that genuinely works for two minutes after the root went quiet is
 * new work, and its end is worth the second notification.
 *
 * Only root agents are watched. `projectSummary` already rolls a child's
 * activity into its root through `hasRunningRlmChildren` — which is exactly how
 * the straggler shows up here, as the root flicking back to working — so
 * children would contribute nothing but false endings: a subagent that runs
 * two minutes would arm itself and announce its own completion while the root
 * is still mid-turn.
 *
 * `blocked` is not idle and never settles. An agent is blocked because it
 * raised an attention request, which has already sent its own notification;
 * settling there would follow "needs your answer" with "finished" for the same
 * moment.
 */

export interface TurnEndEvent {
  agentId: string;
  outcome: "complete" | "failed";
}

export interface TurnEndNotifierOptions {
  catalog: () => CatalogSnapshot;
  notify: (event: TurnEndEvent) => void;
  now?: () => number;
  /** How long an agent must be continuously idle before its turn is over. */
  quietMs?: number;
  /** How long it must work continuously to arm itself without being told. */
  resumeMs?: number;
}

export const DEFAULT_QUIET_MS = 45_000;
export const DEFAULT_RESUME_MS = 90_000;

interface AgentState {
  /** A notification is owed for this agent's current turn. */
  armed: boolean;
  /** When it last became idle, or null while it is working or blocked. */
  idleSince: number | null;
  /** When it last started working, or null while it is not. */
  workingSince: number | null;
}

function isWatched(agent: AgentSummary): boolean {
  // Roots only: see the note above about children announcing their own endings.
  return agent.parentId === null;
}

export class TurnEndNotifier {
  private readonly states = new Map<string, AgentState>();
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly resumeMs: number;

  constructor(private readonly options: TurnEndNotifierOptions) {
    this.now = options.now ?? Date.now;
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.resumeMs = options.resumeMs ?? DEFAULT_RESUME_MS;
  }

  /**
   * Something asked this agent for work: the browser sent it a message, or
   * answered a question it was blocked on. Either way a notification is owed
   * when it next goes quiet.
   */
  arm(agentId: string): void {
    const state = this.stateFor(agentId);
    state.armed = true;
  }

  /**
   * An attention request just took this agent's news. Whatever it was going to
   * be told about the turn, it has been told something better and more
   * specific; a "finished" behind it would be noise about the same moment.
   */
  disarm(agentId: string): void {
    const state = this.states.get(agentId);
    if (state) state.armed = false;
  }

  /** Reads the catalog and sends whatever is now due. Cheap; call it often. */
  tick(): void {
    const agents = this.options.catalog().agents.filter(isWatched);
    const present = new Set<string>();
    const at = this.now();

    for (const agent of agents) {
      present.add(agent.id);
      const state = this.stateFor(agent.id);
      const working = agent.activity === "working" || agent.lifecycle === "starting";
      const settled = !working && agent.activity === "idle";

      if (working) {
        state.idleSince = null;
        if (state.workingSince === null) state.workingSince = at;
        // Long enough to be a real turn rather than a straggler's few seconds.
        else if (at - state.workingSince >= this.resumeMs) state.armed = true;
        continue;
      }

      state.workingSince = null;
      if (!settled) {
        // Blocked, or a lifecycle that is not a finished turn at all. Not an
        // ending, and the clock does not run.
        state.idleSince = null;
        continue;
      }

      if (state.idleSince === null) state.idleSince = at;
      if (!state.armed || at - state.idleSince < this.quietMs) continue;

      state.armed = false;
      this.options.notify({
        agentId: agent.id,
        outcome: agent.lifecycle === "failed" ? "failed" : "complete",
      });
    }

    // An agent that has left the catalog cannot be notified about, and holding
    // its state would leak one entry per deleted session.
    for (const id of [...this.states.keys()]) if (!present.has(id)) this.states.delete(id);
  }

  private stateFor(agentId: string): AgentState {
    const existing = this.states.get(agentId);
    if (existing) return existing;
    const created: AgentState = { armed: false, idleSince: null, workingSince: null };
    this.states.set(agentId, created);
    return created;
  }
}
