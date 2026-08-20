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
type Listener = (frame: ServerFrame) => void;

interface StreamState {
  id: string;
  seq: number;
  snapshot: StreamSnapshot;
  events: EventEnvelope[];
  listeners: Set<Listener>;
}

export class EventHub {
  readonly epoch = randomUUID();
  private readonly streams = new Map<string, StreamState>();

  constructor(
    private readonly ringSize = 256,
    private readonly replayBatchThreshold = 64,
  ) {}

  register(streamId: string, snapshot: StreamSnapshot): void {
    const current = this.streams.get(streamId);
    if (current) {
      current.snapshot = structuredClone(snapshot);
      return;
    }
    this.streams.set(streamId, {
      id: streamId,
      seq: 0,
      snapshot: structuredClone(snapshot),
      events: [],
      listeners: new Set(),
    });
  }

  has(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  getSnapshot<T extends StreamSnapshot>(streamId: string): T | null {
    const stream = this.streams.get(streamId);
    return stream ? (structuredClone(stream.snapshot) as T) : null;
  }

  publish(streamId: string, event: GatewayEvent, snapshot: StreamSnapshot): EventEnvelope {
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
    stream.events.push(envelope);
    if (stream.events.length > this.ringSize) {
      stream.events.splice(0, stream.events.length - this.ringSize);
    }

    const frame: ServerFrame = { type: "event", version: PROTOCOL_VERSION, envelope };
    for (const listener of stream.listeners) listener(frame);
    return envelope;
  }

  attach(
    streamId: string,
    since: StreamCursor | null | undefined,
    listener: Listener,
  ): { initial: ServerFrame; detach: () => void } | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;

    // Registration and initial-frame creation are synchronous. This guarantees
    // events emitted after attach are queued after the initial frame.
    stream.listeners.add(listener);
    const cursor = { epoch: this.epoch, seq: stream.seq };
    let initial: ServerFrame;

    if (!since || since.epoch !== this.epoch || since.seq > stream.seq) {
      initial = this.snapshotFrame(stream, cursor);
    } else {
      const gap = stream.seq - since.seq;
      const oldestSeq = stream.events[0]?.seq ?? stream.seq + 1;
      const covered = gap === 0 || since.seq + 1 >= oldestSeq;
      if (covered && gap <= this.replayBatchThreshold) {
        initial = {
          type: "replay",
          version: PROTOCOL_VERSION,
          streamId,
          cursor,
          events: structuredClone(stream.events.filter((event) => event.seq > since.seq)),
        };
      } else {
        initial = this.snapshotFrame(stream, cursor);
      }
    }

    return {
      initial,
      detach: () => stream.listeners.delete(listener),
    };
  }

  close(): void {
    for (const stream of this.streams.values()) {
      const frame: ServerFrame = {
        type: "detached",
        version: PROTOCOL_VERSION,
        streamId: stream.id,
        reason: "server_shutdown",
      };
      for (const listener of stream.listeners) listener(frame);
      stream.listeners.clear();
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
