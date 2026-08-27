import { ChevronRight } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import type { TranscriptMessage } from "../../protocol";
import { useSettings } from "../settings";

export type TurnListItem =
  | { kind: "turn"; key: string; turnId: string; rows: TranscriptMessage[] }
  | { kind: "row"; key: string; row: TranscriptMessage };

/**
 * Groups a transcript into turns by CONSECUTIVE turnId. Rows without a turnId
 * (legacy/system rows) stay flat between groups. A turnId run split by a flat
 * row produces two turn items, so keys are deduplicated at construction.
 */
export function groupIntoTurns(messages: readonly TranscriptMessage[]): TurnListItem[] {
  const items: TurnListItem[] = [];
  const usedKeys = new Set<string>();
  const claimKey = (candidate: string): string => {
    let key = candidate;
    for (let attempt = 2; usedKeys.has(key); attempt++) key = `${candidate}#${attempt}`;
    usedKeys.add(key);
    return key;
  };
  for (const message of messages) {
    if (!message.turnId) {
      items.push({ kind: "row", key: claimKey(message.id), row: message });
      continue;
    }
    const last = items.at(-1);
    if (last?.kind === "turn" && last.turnId === message.turnId) {
      last.rows.push(message);
    } else {
      items.push({ kind: "turn", key: claimKey(message.turnId), turnId: message.turnId, rows: [message] });
    }
  }
  return items;
}

export interface TurnSections {
  /** The opening user prompt row(s) — always visible. */
  prompt: TranscriptMessage[];
  /** Intermediate work (tool/thinking/python/refine/notice rows) — collapsible. */
  work: TranscriptMessage[];
  /** The trailing outcome (assistant answer, terminal error, or a slash command's terminal refine row) — always visible. */
  tail: TranscriptMessage[];
}

function isOutcomeRow(row: TranscriptMessage, isLastRowOfTurn: boolean): boolean {
  const kind = row.presentation?.kind;
  if (kind === undefined) return true;
  if (kind === "error") return true;
  // A /refine turn's terminal refine row is that turn's whole outcome; a
  // refine that happened mid-turn is work like any other row.
  if (kind === "refine" && isLastRowOfTurn) return true;
  return false;
}

/**
 * Kinds that ride along with the outcome instead of ending the run of it.
 *
 * The tail is a contiguous suffix, so any row that is not an outcome hides
 * everything before it. A subagent that reports late lands between the
 * assistant's answer and whatever it says next, and treating that report as
 * work collapsed the answer — the entire point of the turn — behind "N steps".
 * These rows are not outcomes themselves; they simply must not bury one.
 */
function ridesWithOutcome(row: TranscriptMessage): boolean {
  return row.presentation?.kind === "agent-message";
}

export function splitTurn(rows: readonly TranscriptMessage[]): TurnSections {
  let promptEnd = 0;
  while (promptEnd < rows.length && rows[promptEnd].role === "user" && !rows[promptEnd].presentation) promptEnd++;
  let tailStart = rows.length;
  while (tailStart > promptEnd
    && (isOutcomeRow(rows[tailStart - 1], tailStart === rows.length) || ridesWithOutcome(rows[tailStart - 1]))) {
    tailStart--;
  }
  // Ride-along rows cannot form a tail by themselves: a turn whose last row is
  // an incoming subagent report has not produced an outcome, and promoting one
  // would make turnSettled() call the turn finished while the assistant is
  // still working on its reply.
  const hasOutcome = rows.slice(tailStart).some((row, index) =>
    isOutcomeRow(row, tailStart + index === rows.length - 1));
  if (!hasOutcome) tailStart = rows.length;
  return { prompt: rows.slice(0, promptEnd), work: rows.slice(promptEnd, tailStart), tail: rows.slice(tailStart) };
}

/**
 * Prose this long, sitting inside a turn's work, is an answer rather than
 * narration — and answers are not collapsed.
 *
 * Measured against 187 turns of real transcript: 36% of them had a substantial
 * answer hidden inside the work while something shorter stood as the turn's
 * visible conclusion, a median of 17x more text hidden than shown. The cause is
 * ordinary: `splitTurn` can only keep the final contiguous run of outcome rows,
 * so any tool call after an answer buries it.
 *
 * The threshold is a judgement, checked against the same transcripts: at 200
 * chars a turn gains a median of one extra collapsed block and keeps a median
 * of one visible answer. Lower floods the view with pills around every one-line
 * aside (max 41 per turn), higher hides real answers again.
 */
export const VISIBLE_PROSE_CHARS = 200;

export type TurnSegment =
  | { kind: "work"; key: string; rows: TranscriptMessage[] }
  | { kind: "visible"; key: string; rows: TranscriptMessage[] };

function isSubstantiveProse(row: TranscriptMessage): boolean {
  return row.role === "assistant"
    && row.presentation === undefined
    && row.text.trim().length >= VISIBLE_PROSE_CHARS;
}

/**
 * The turn as an ordered run of collapsed work and visible prose.
 *
 * Layered on splitTurn rather than replacing it: the prompt and the final
 * outcome run are decided exactly as before — so a one-word closing answer is
 * still visible however short it is — and this only promotes long answers that
 * would otherwise be buried in between.
 */
export function splitTurnSegments(rows: readonly TranscriptMessage[]): { prompt: TranscriptMessage[]; segments: TurnSegment[] } {
  const { prompt, work, tail } = splitTurn(rows);
  const segments: TurnSegment[] = [];
  let run: TranscriptMessage[] = [];
  const flush = () => {
    if (!run.length) return;
    segments.push({ kind: "work", key: `work-${run[0].id}`, rows: run });
    run = [];
  };
  for (const row of work) {
    if (isSubstantiveProse(row)) {
      flush();
      segments.push({ kind: "visible", key: `visible-${row.id}`, rows: [row] });
    } else {
      run.push(row);
    }
  }
  flush();
  if (tail.length) segments.push({ kind: "visible", key: `tail-${tail[0].id}`, rows: tail });
  return { prompt, segments };
}

function rowActive(row: TranscriptMessage): boolean {
  if (row.state === "streaming") return true;
  const presentation = row.presentation;
  if (!presentation) return false;
  if (presentation.kind === "python" || presentation.kind === "tool") {
    return presentation.status === "running" || presentation.status === "waiting";
  }
  if (presentation.kind === "refine") return presentation.status === "running";
  return false;
}

/** A turn is settled once an outcome row exists and nothing in it is still streaming or running. */
export function turnSettled(rows: readonly TranscriptMessage[]): boolean {
  return splitTurn(rows).tail.length > 0 && !rows.some(rowActive);
}

export function summarizeTurnWork(work: readonly TranscriptMessage[]): { steps: number; durationMs: number } {
  let durationMs = 0;
  for (const row of work) {
    const presentation = row.presentation;
    if (presentation?.kind === "python" && presentation.durationMs) durationMs += presentation.durationMs;
  }
  return { steps: work.length, durationMs };
}

/**
 * How long the turn actually took, first row to last.
 *
 * The summary used to show summarizeTurnWork's durationMs, which only ever
 * added up python cell durations — so a turn that spent four minutes in tool
 * calls, model latency and network waits announced itself as "689ms". Row
 * timestamps are the only end-to-end clock the transcript carries. Returns 0
 * when the span is unusable (single row, unparseable or backwards timestamps),
 * and the caller then shows the step count alone rather than a wrong number.
 */
export function turnWallClockMs(rows: readonly TranscriptMessage[]): number {
  if (rows.length < 2) return 0;
  const start = Date.parse(rows[0].createdAt);
  const end = Date.parse(rows[rows.length - 1].createdAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

export function formatWorkDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  // Wall-clock spans land on whole minutes often enough that "2m 0s" would be
  // the common case; drop the empty tail.
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export interface TurnGroupProps {
  turnId: string;
  /** The turn's rows, in transcript order; the array is full-replaced every tick. */
  rows: TranscriptMessage[];
  /** Session recap — pass only for the transcript's final turn, where it names this turn's work. */
  recap?: string;
  /** Must return a keyed element per row; identity changes are deliberately ignored by the memo comparator. */
  renderRow: (message: TranscriptMessage) => ReactNode;
}

function TurnGroupImpl({ rows, recap, renderRow }: TurnGroupProps) {
  // An explicit user choice overrides auto-collapse in both directions and
  // persists for the session (the component stays mounted under its turnId key).
  const [userChoice, setUserChoice] = useState<boolean | undefined>(undefined);
  const { settings } = useSettings();
  const { prompt, segments } = splitTurnSegments(rows);
  const work = segments.flatMap((segment) => segment.kind === "work" ? segment.rows : []);
  const settled = turnSettled(rows);
  // A live turn stays open whatever the setting says — its work is what the
  // user is watching. `turnsCollapsed` only decides where a turn lands once
  // it settles, and any explicit choice still wins over both.
  const open = userChoice ?? (settled ? !settings.turnsCollapsed : true);
  // Work rows stay unmounted until the turn is first opened. A closed <details>
  // contributes none of their height, so this changes nothing on screen — but at
  // a realistic 20 steps per turn those rows are ~89% of the transcript's DOM
  // nodes and most of its heap. Once a turn has been opened its rows stay
  // mounted, so re-collapsing preserves whatever the user expanded inside them.
  const [everOpened, setEverOpened] = useState(open);
  const mountWork = open || everOpened;
  const { steps } = summarizeTurnWork(work);
  const durationMs = turnWallClockMs(rows);
  const stepsLabel = `${steps} step${steps === 1 ? "" : "s"}`;
  const countsLabel = durationMs > 0 ? `${stepsLabel} · ${formatWorkDuration(durationMs)}` : stepsLabel;
  const useRecap = settled && Boolean(recap);
  const summaryText = !settled ? `Working… · ${stepsLabel}` : useRecap ? recap! : countsLabel;

  const toggle = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!open) setEverOpened(true);
    setUserChoice(!open);
  };
  // Every work block in a turn shares one open state: expanding is a decision
  // about the turn, not about one of its runs, and `turnsCollapsed` is a
  // per-turn setting. The first block carries the turn-level labels; the rest
  // describe only their own run, so the counts stay truthful.
  let workBlocksSeen = 0;

  return (
    <div className="turn-group" data-settled={settled || undefined}>
      {prompt.map(renderRow)}
      {segments.map((segment) => {
        if (segment.kind === "visible") return segment.rows.map(renderRow);
        const first = workBlocksSeen++ === 0;
        // Each block counts its OWN rows: a pill that says "3 steps" and opens
        // onto two of them is lying about the thing it controls. The turn's
        // end-to-end duration is a turn property, so it rides on the first
        // block and is not repeated — later blocks time only their own run.
        const runSteps = segment.rows.length;
        const runLabel = `${runSteps} step${runSteps === 1 ? "" : "s"}`;
        const runActive = segment.rows.some(rowActive);
        const runDuration = first ? durationMs : turnWallClockMs(segment.rows);
        const label = runDuration > 0 ? `${runLabel} · ${formatWorkDuration(runDuration)}` : runLabel;
        const text = !settled && runActive ? `Working… · ${runLabel}`
          : first && useRecap ? recap!
          : label;
        return (
          <details
            key={segment.key}
            className="turn-work"
            open={open}
            data-state={settled ? "settled" : "live"}
          >
            <summary className="turn-summary" aria-label={`Turn details, ${label}`} onClick={toggle}>
              <ChevronRight className="turn-chevron" aria-hidden="true" />
              <span className="turn-summary-text">{text}</span>
              {first && useRecap && <span className="turn-summary-meta">{label}</span>}
            </summary>
            <div className="turn-work-rows">{mountWork ? segment.rows.map(renderRow) : null}</div>
          </details>
        );
      })}
    </div>
  );
}

function presentationFingerprint(row: TranscriptMessage): string {
  const presentation = row.presentation;
  const status = presentation && "status" in presentation ? presentation.status : "";
  return `${row.id}\0${row.state}\0${presentation?.kind ?? ""}\0${status}`;
}

/**
 * Settled turns skip the per-tick re-render the full-replaced messages array
 * would otherwise cause; live turns always re-render (their row text/status is
 * what's changing). renderRow identity is ignored on purpose: it closes over
 * only ref-backed handlers, so a stale closure stays correct.
 */
function turnGroupPropsEqual(previous: TurnGroupProps, next: TurnGroupProps): boolean {
  if (previous.turnId !== next.turnId || previous.recap !== next.recap) return false;
  if (!turnSettled(next.rows)) return false;
  if (previous.rows.length !== next.rows.length) return false;
  const last = next.rows.length - 1;
  if (previous.rows[last].text !== next.rows[last].text) return false;
  for (let index = 0; index < next.rows.length; index++) {
    if (presentationFingerprint(previous.rows[index]) !== presentationFingerprint(next.rows[index])) return false;
  }
  return true;
}

export const TurnGroup = memo(TurnGroupImpl, turnGroupPropsEqual);
