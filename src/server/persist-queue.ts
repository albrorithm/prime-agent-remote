import { writeSecretFileAtomically } from "./atomic-file.js";

export const DEFAULT_PERSIST_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

export interface PersistQueueOptions {
  /** Injectable so tests do not have to wait on real backoff delays. */
  retryDelaysMs?: readonly number[];
  /**
   * Called once when every retry has failed too. The caller knows what its
   * file is for and can say what a stale one means operationally.
   */
  onRetriesExhausted?: () => void;
}

/**
 * Serializes atomic writes of one file and retries the ones the disk rejects.
 *
 * The stores that use this hold their state in memory and treat the file as a
 * copy of it. Once a caller has changed the memory, that memory is the only
 * correct view in this process, and a failed write leaves the file stale.
 * Silently accepting that would let a revoked device or push subscription
 * come back after a restart, so a failed write is retried a bounded number of
 * times with backoff, and the first failure is still reported to the caller so
 * an operation that must not proceed on a stale file — issuing a credential —
 * can refuse.
 *
 * Every write re-renders the current state, and each retry does too, so a
 * retry never puts an older picture over a newer one. Timers are `unref()`ed:
 * a queue with a retry in flight never keeps the process alive on its own.
 */
export class PersistQueue {
  /** The tracked tail, which never rejects: see `persist`. */
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private persistedRevision = 0;

  private retryTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  private readonly retryDelaysMs: readonly number[];

  constructor(
    private readonly filePath: string,
    private readonly render: () => string,
    private readonly options: PersistQueueOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_PERSIST_RETRY_DELAYS_MS;
  }

  get hasPendingWrite(): boolean {
    return this.persistedRevision < this.revision;
  }

  /**
   * Writes the state as it is now. Resolves when that write is on disk and
   * rejects when it is not, whether or not a retry has been scheduled.
   */
  persist(): Promise<void> {
    const body = this.render();
    const revision = ++this.revision;
    const write = this.tail.then(() => writeSecretFileAtomically(this.filePath, body), () => writeSecretFileAtomically(this.filePath, body));
    // The tracked tail must never reject, or an earlier failure would reject
    // every later write that merely queued behind it.
    this.tail = write.catch(() => {});
    write.then(
      () => this.onSucceeded(revision),
      () => this.onFailed(),
    );
    return write;
  }

  private onSucceeded(revision: number): void {
    this.persistedRevision = revision;
    if (this.hasPendingWrite) return;
    this.cancelRetry();
    this.retryAttempt = 0;
  }

  /**
   * Every mutation of the owning store calls `persist` again with the state
   * as it stands, so this timer only matters when nothing else touches the
   * store in the meantime — the case a revocation right before a quiet restart
   * falls into.
   */
  private onFailed(): void {
    this.cancelRetry();
    if (this.retryAttempt >= this.retryDelaysMs.length) {
      this.retryAttempt = 0;
      this.options.onRetriesExhausted?.();
      return;
    }
    const delay = this.retryDelaysMs[this.retryAttempt];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.persist().catch(() => {});
    }, delay);
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
