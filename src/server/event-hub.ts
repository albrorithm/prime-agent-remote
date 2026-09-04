import { randomUUID } from "node:crypto";
import type {
  AgentSnapshot,
  CatalogSnapshot,
  EventEnvelope,
  GatewayEvent,
  ServerFrame,
  StreamCursor,
} from "../protocol.js";
import { PROTOCOL_VERSION } from "../protocol.js";

type StreamSnapshot = CatalogSnapshot | AgentSnapshot;
type Listener = (frame: ServerFrame) => void | Promise<void>;

interface ListenerRegistration {
  streamId: string;
  listener: Listener;
  active: boolean;
}

interface StoredEvent {
  envelope: EventEnvelope;
  bytes: number;
}

interface StreamState {
  id: string;
  seq: number;
  snapshot: StreamSnapshot;
  events: StoredEvent[];
  replayBytes: number;
  listeners: Set<ListenerRegistration>;
}

const DEFAULT_REPLAY_BYTE_BUDGET = 1024 * 1024;

export class EventHub {
  readonly epoch = randomUUID();
  private readonly streams = new Map<string, StreamState>();
  /**
   * The highest seq each stream id ever issued, kept across unregister. The
   * epoch names the process, not a stream generation, so a re-registered id
   * (ordinary: ids derive from session identity) that restarted at 0 would
   * let a stale cursor pass every check and miss what the new one published.
   */
  private readonly seqHighWater = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly ringSize = 256,
    private readonly replayBatchThreshold = 64,
    private readonly replayByteBudget = DEFAULT_REPLAY_BYTE_BUDGET,
  ) {}

  register(streamId: string, snapshot: StreamSnapshot): void {
    if (this.closed) throw new Error("EventHub is closed");
    const current = this.streams.get(streamId);
    if (current) {
      current.snapshot = structuredClone(snapshot);
      return;
    }
    // One past the high-water, not at it: a re-registered stream that has
    // published nothing would otherwise answer a stale cursor with an empty
    // replay instead of the snapshot a restarted stream owes it.
    const previous = this.seqHighWater.get(streamId);
    this.streams.set(streamId, {
      id: streamId,
      seq: previous === undefined ? 0 : previous + 1,
      snapshot: structuredClone(snapshot),
      events: [],
      replayBytes: 0,
      listeners: new Set(),
    });
  }

  unregister(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    this.notifyAll(stream, {
      type: "detached",
      version: PROTOCOL_VERSION,
      streamId,
      reason: "stream_gone",
    });
    for (const registration of stream.listeners) registration.active = false;
    stream.listeners.clear();
    this.seqHighWater.set(streamId, stream.seq);
    return this.streams.delete(streamId);
  }

  has(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  getSnapshot<T extends StreamSnapshot>(streamId: string): T | null {
    const stream = this.streams.get(streamId);
    return stream ? (structuredClone(stream.snapshot) as T) : null;
  }

  publish(streamId: string, event: GatewayEvent, snapshot: StreamSnapshot): EventEnvelope {
    if (this.closed) throw new Error("EventHub is closed");
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Unknown stream: ${streamId}`);

    stream.seq += 1;
    stream.snapshot = structuredClone(snapshot);
    const envelope: EventEnvelope = {
      version: PROTOCOL_VERSION,
      streamId,
      epoch: this.epoch,
      seq: stream.seq,
      emittedAt: new Date().toISOString(),
      event: structuredClone(event),
    };

    // A replace event contains the complete current state. Older events add no
    // replay value and can amplify a large snapshot up to ringSize times.
    if (event.kind === "agent.replaced" || event.kind === "catalog.replaced") {
      stream.events = [];
      stream.replayBytes = 0;
    }
    const bytes = this.serializedBytes(envelope);
    if (bytes <= this.replayByteBudget) {
      stream.events.push({ envelope, bytes });
      stream.replayBytes += bytes;
    } else {
      // Replay coverage must remain contiguous. Once one sequence cannot be
      // retained, all older events become unsafe replay starting points.
      stream.events = [];
      stream.replayBytes = 0;
    }
    while (stream.events.length > this.ringSize || stream.replayBytes > this.replayByteBudget) {
      const removed = stream.events.shift();
      stream.replayBytes -= removed?.bytes ?? 0;
    }

    const frame: ServerFrame = { type: "event", version: PROTOCOL_VERSION, envelope };
    this.notifyAll(stream, frame);
    return envelope;
  }

  attach(
    streamId: string,
    since: StreamCursor | null | undefined,
    listener: Listener,
  ): { initial: ServerFrame; detach: () => void } | null {
    if (this.closed) return null;
    const stream = this.streams.get(streamId);
    if (!stream) return null;

    // Registration and initial-frame creation are synchronous. This guarantees
    // events emitted after attach are queued after the initial frame.
    const registration: ListenerRegistration = { streamId, listener, active: true };
    stream.listeners.add(registration);
    const cursor = { epoch: this.epoch, seq: stream.seq };
    let initial: ServerFrame;

    if (!since || since.epoch !== this.epoch || since.seq > stream.seq) {
      initial = this.snapshotFrame(stream, cursor);
    } else {
      const gap = stream.seq - since.seq;
      const oldestSeq = stream.events[0]?.envelope.seq ?? stream.seq + 1;
      const covered = gap === 0 || since.seq + 1 >= oldestSeq;
      if (covered && gap <= this.replayBatchThreshold) {
        initial = {
          type: "replay",
          version: PROTOCOL_VERSION,
          streamId,
          cursor,
          events: structuredClone(stream.events
            .map(({ envelope }) => envelope)
            .filter((event) => event.seq > since.seq)),
        };
      } else {
        initial = this.snapshotFrame(stream, cursor);
      }
    }

    return {
      initial,
      // Capture only the small registration token. Holding a detach callback
      // after unregister must not retain the stream snapshot and replay ring.
      detach: () => this.detachRegistration(registration),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) {
      this.notifyAll(stream, {
        type: "detached",
        version: PROTOCOL_VERSION,
        streamId: stream.id,
        reason: "server_shutdown",
      });
      for (const registration of stream.listeners) registration.active = false;
      stream.listeners.clear();
    }
    this.streams.clear();
  }

  private detachRegistration(registration: ListenerRegistration): void {
    if (!registration.active) return;
    registration.active = false;
    this.streams.get(registration.streamId)?.listeners.delete(registration);
  }

  private notifyAll(stream: StreamState, frame: ServerFrame): void {
    for (const registration of stream.listeners) {
      if (!registration.active) continue;
      try {
        const result = registration.listener(frame);
        if (result && typeof result.then === "function") void result.catch(() => {});
      } catch {
        // A broken socket/listener must not block delivery to other clients.
      }
    }
  }

  private serializedBytes(envelope: EventEnvelope): number {
    try {
      return Buffer.byteLength(JSON.stringify(envelope), "utf8");
    } catch {
      // Non-serializable envelopes cannot be replayed, but live delivery still
      // lets the transport apply its own failure handling.
      return Number.POSITIVE_INFINITY;
    }
  }

  private snapshotFrame(stream: StreamState, cursor: StreamCursor): ServerFrame {
    return {
      type: "snapshot",
      version: PROTOCOL_VERSION,
      streamId: stream.id,
      cursor,
      snapshot: structuredClone(stream.snapshot),
    };
  }
}
