import type { SessionQueue } from "../../protocol";

/**
 * How many queued entries the strip names before it collapses the rest into a
 * count. Four is what fits above the composer on a phone without the strip
 * becoming the thing you read instead of the transcript.
 */
export const MAX_QUEUE_STRIP_ROWS = 4;

const LANE_LABEL = { steering: "Steering", followUp: "After run" } as const;

/**
 * What Prime is holding for this session and has not handed to the model yet.
 *
 * Read-only on purpose. The queue lives in Prime; nothing here can cancel or
 * reorder an entry, and a control that looked like it could would be lying.
 * This is also not the composer's own "Sending…" state: that is about a
 * request in flight from this device, this is about what the daemon holds.
 */
export function QueueStrip({ queue }: { queue: SessionQueue }) {
  if (queue.queuedCount <= 0) return null;
  const rows = [
    ...queue.steering.map((entry) => ({ lane: LANE_LABEL.steering, entry })),
    ...queue.followUp.map((entry) => ({ lane: LANE_LABEL.followUp, entry })),
  ].slice(0, MAX_QUEUE_STRIP_ROWS);
  // `queuedCount` counts what the two lanes never list — session commands, and
  // anything past the per-lane cap — so the remainder is measured against it
  // rather than against the lanes' own lengths.
  const more = Math.max(0, queue.queuedCount - rows.length);

  return (
    <div className="queue-strip" role="group" aria-label={`Queued in Prime, ${queue.queuedCount}`}>
      {/* The separator is decoration; the group's label says the same thing in
          words, so a screen reader is not read a middle dot. */}
      <p className="queue-strip-header" aria-hidden="true">Queued in Prime · {queue.queuedCount}</p>
      <ul className="queue-strip-rows">
        {rows.map(({ lane, entry }, index) => (
          <li key={`${lane}:${index}`}>
            <span className="queue-strip-lane">{lane}</span>
            <span className="queue-strip-text">{entry.truncated ? `${entry.text}…` : entry.text}</span>
          </li>
        ))}
        {more > 0 && <li className="queue-strip-more">+{more} more</li>}
      </ul>
    </div>
  );
}
