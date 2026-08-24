import type {
  AgentSnapshot,
  AgentSummary,
  CatalogSnapshot,
  DirectoryListing,
  ImageMimeType,
  MutationAccepted,
  SessionCreated,
  SlashCommandAccepted,
  SlashCommandCatalog,
} from "../protocol.js";
import type { EventHub } from "./event-hub.js";
import type { ValidatedImageAttachment } from "./image-attachments.js";

export interface SendMessageInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
  text: string;
  images: ValidatedImageAttachment[];
}

export interface ExecuteSlashCommandInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
  name: string;
  args: string;
}

export interface AttachmentData {
  mimeType: ImageMimeType;
  bytes: Uint8Array;
}

export interface ResolveAttentionInput {
  attentionId: string;
  requestId: string;
  expectedRevision: number;
  optionId: string;
}

export interface AbortInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
}

export interface CreateSessionInput {
  requestId: string;
  cwd: string;
  name?: string;
}

export class BackendConflictError extends Error {}
export class BackendNotFoundError extends Error {}
export class BackendCapabilityError extends Error {}

export function uniqueSessionName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const trimmed = base.trim();
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${trimmed} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Serializes async operations that share a key so overlapping commands for the
 * same agent cannot interleave partial adapter state.
 */
export async function withSerialLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  locks.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

interface CoalescedRefreshWaiter {
  generation: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface CoalescedRefreshQueueOptions {
  /** One refresh pass. A batch runs up to maxBatch passes while triggers are pending. */
  run: () => Promise<void>;
  maxBatch: number;
  /** Debounce between a trigger (or a finished batch with pending work) and the next batch. */
  delayMs: number;
  /**
   * Backoff before re-running after a failed pass; the last entry repeats.
   * Omit to drop failed work — appropriate only when something else (like a
   * poll) re-triggers the queue anyway.
   */
  retryDelaysMs?: readonly number[];
  /** Called after a successful pass with the request generation it covered. */
  onSuccess?: (generation: number) => void;
  /** Called after each failed pass with the consecutive-failure count (1 on the first). */
  onFailure?: (error: Error, consecutiveFailures: number) => void;
  /** Called when a pass succeeds after one or more failures. */
  onRecovered?: () => void;
}

/**
 * Coalesces bursty refresh triggers into serialized, batched async work.
 * Requests are generation-numbered so a waiter settles only once a pass that
 * started at or after its request completes, and a failed pass rejects its
 * waiters instead of abandoning them.
 */
export class CoalescedRefreshQueue {
  private requestedGeneration = 0;
  private processedGeneration = 0;
  private readonly waiters: CoalescedRefreshWaiter[] = [];
  private batch?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private consecutiveFailures = 0;
  private closed = false;

  constructor(private readonly options: CoalescedRefreshQueueOptions) {}

  /** Generation assigned to the most recent trigger or request. */
  get generation(): number {
    return this.requestedGeneration;
  }

  /** Mark the tracked state dirty and start a batch after the debounce delay. */
  trigger(): void {
    if (this.closed) return;
    this.requestedGeneration += 1;
    this.scheduleBatch(this.options.delayMs);
  }

  /** Mark dirty, start immediately, and settle once a covering pass completes. */
  request(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const generation = ++this.requestedGeneration;
    const settled = new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation, resolve, reject });
    });
    this.startBatch();
    return settled;
  }

  /** Stop future work, await the in-flight batch, and resolve outstanding waiters. */
  close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const inflight = this.batch ?? Promise.resolve();
    return inflight.then(() => this.settleWaiters(Number.POSITIVE_INFINITY));
  }

  private scheduleBatch(delayMs: number): void {
    if (this.closed || this.batch || this.timer
      || this.processedGeneration >= this.requestedGeneration) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startBatch();
    }, delayMs);
  }

  private startBatch(): void {
    if (this.closed || this.batch || this.processedGeneration >= this.requestedGeneration) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // drainBatch never rejects, so completion is chained directly: an extra
    // catch hop would delay clearing the batch slot past callers that queue
    // follow-up requests in the same tick.
    const batch = this.drainBatch();
    this.batch = batch;
    void batch.then(() => {
      if (this.batch !== batch) return;
      this.batch = undefined;
      this.scheduleBatch(this.consecutiveFailures > 0 ? this.retryDelay() : this.options.delayMs);
    });
  }

  private async drainBatch(): Promise<void> {
    for (let count = 0; count < this.options.maxBatch && !this.closed
      && this.processedGeneration < this.requestedGeneration; count += 1) {
      const generation = this.requestedGeneration;
      try {
        await this.options.run();
        this.processedGeneration = generation;
        const recovered = this.consecutiveFailures > 0;
        this.consecutiveFailures = 0;
        this.options.onSuccess?.(generation);
        this.settleWaiters(generation);
        if (recovered) {
          try { this.options.onRecovered?.(); } catch { /* Observer only. */ }
        }
      } catch (error) {
        this.processedGeneration = generation;
        this.consecutiveFailures += 1;
        const failure = error instanceof Error ? error : new Error("Refresh failed");
        this.settleWaiters(generation, failure);
        // Hooks are best-effort observers; a throwing hook must not wedge the queue.
        try { this.options.onFailure?.(failure, this.consecutiveFailures); } catch { /* Observer only. */ }
        if (this.options.retryDelaysMs?.length) {
          // Re-mark the dropped work dirty and leave the batch so the next
          // attempt waits out the backoff instead of retrying hot.
          this.requestedGeneration += 1;
          return;
        }
      }
    }
  }

  private retryDelay(): number {
    const delays = this.options.retryDelaysMs ?? [];
    return delays[Math.min(this.consecutiveFailures - 1, delays.length - 1)] ?? this.options.delayMs;
  }

  private settleWaiters(generation: number, error?: Error): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (!waiter || waiter.generation > generation) continue;
      this.waiters.splice(index, 1);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}

export interface AgentBackend {
  readonly kind: "demo" | "prime";
  initialize(hub: EventHub): Promise<void>;
  catalog(): CatalogSnapshot;
  agentSnapshot(agentId: string): Promise<AgentSnapshot | null>;
  sendMessage(input: SendMessageInput): Promise<MutationAccepted>;
  slashCommandCatalog(agentId: string): Promise<SlashCommandCatalog | null>;
  executeSlashCommand(input: ExecuteSlashCommandInput): Promise<SlashCommandAccepted>;
  attachment(id: string): AttachmentData | null;
  abort(input: AbortInput): Promise<MutationAccepted>;
  resolveAttention(input: ResolveAttentionInput): Promise<MutationAccepted>;
  listDirectories(path?: string): Promise<DirectoryListing>;
  createSession(input: CreateSessionInput): Promise<SessionCreated>;
  close(): Promise<void>;
}
