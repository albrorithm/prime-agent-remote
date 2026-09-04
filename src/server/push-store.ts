import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeSecretFileAtomically } from "./atomic-file.js";

/**
 * A phone is one subscription, and this gateway pairs with a handful of
 * devices at most. The bound exists so a rotating endpoint (browsers do
 * re-mint them) cannot grow the file without limit, not to ration devices.
 */
export const MAX_PUSH_SUBSCRIPTIONS = 20;
export const MAX_PUSH_ENDPOINT_CHARS = 1024;
export const MAX_PUSH_KEY_CHARS = 256;
/** Anything larger is treated as corrupt instead of parsed. */
export const MAX_PUSH_STORE_BYTES = 256 * 1024;
const STORE_VERSION = 1;

export interface StoredPushSubscription {
  endpoint: string;
  /** The subscription's public key, base64url, as the browser supplied it. */
  p256dh: string;
  /** The subscription's auth secret, base64url. */
  auth: string;
  /** The gateway session that most recently claimed this endpoint. */
  sessionId: string;
  /**
   * The paired device the claiming session descended from.
   *
   * Sessions are in memory and die with the process; the subscription
   * deliberately does not. So a record bound only to a session is unreachable
   * from a revocation the moment the gateway restarts or the 12-hour session
   * expires — and the revoked phone keeps being woken. The device credential
   * is the thing that outlives both, so the wake capability is bound to it.
   */
  deviceId?: string;
  createdAt: string;
  /**
   * Whether this device also asked to be told when an agent finishes its turn,
   * not only when one needs an answer. Per device and off unless asked for:
   * turn-end fires far more often than attention ever does, and it is a
   * different appetite for interruption rather than a different agent.
   */
  turnEnd?: boolean;
}

const storedSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_CHARS).url(),
  p256dh: z.string().min(1).max(MAX_PUSH_KEY_CHARS),
  auth: z.string().min(1).max(MAX_PUSH_KEY_CHARS),
  sessionId: z.string().min(1).max(256),
  /* Optional for the same reason `turnEnd` is, below: records written before
     this field existed lack it, and a required field would drop every one of
     them on upgrade. Those legacy records stay reachable through
     `removeSession` while their device is live, and re-acquire a `deviceId`
     the next time the app re-claims its endpoint — which it does on every new
     session. `removeAll` is what covers them when no device is live at all. */
  deviceId: z.string().min(1).max(256).optional(),
  createdAt: z.string().min(1).max(64),
  /* Optional, and that is load-bearing rather than lax. Every record written
     before this field existed lacks it, `.strict()` rejects what it does not
     know, and an unreadable store "falls back to empty rather than failing
     startup" — so requiring it would have silently unsubscribed every device
     already paired, on upgrade, with no error anywhere. */
  turnEnd: z.boolean().optional(),
}).strict();

const storeFileSchema = z.object({
  version: z.number().int(),
  subscriptions: z.array(z.unknown()).max(MAX_PUSH_SUBSCRIPTIONS * 4),
});

/**
 * How long to wait before re-attempting a write the disk rejected, and how
 * many times to try before giving up and just logging. Injectable so tests
 * don't have to wait on real backoff delays.
 */
const DEFAULT_PERSIST_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

/**
 * The gateway's only persistent state.
 *
 * Everything else here is in-memory and dies with the process, which is a
 * property the security model leans on. A push subscription cannot be: it is a
 * capability to wake a device, and it has to outlive both the process and the
 * 12-hour session cookie that authorized it, or push stops working overnight —
 * which is exactly when an agent that needs an answer is worth waking someone
 * for. Records are dropped by explicit sign-out, by an explicit unsubscribe,
 * and by a push service reporting the endpoint gone. Not by time.
 */
export class PushSubscriptionStore {
  private records: StoredPushSubscription[] = [];
  /** Serializes writes so two concurrent mutations cannot interleave renames. */
  private writes: Promise<unknown> = Promise.resolve();
  /**
   * Tracks a pending re-attempt after a write failed. A failed write leaves
   * `records` (already updated by the caller — see `removeEndpoint`) as the
   * only correct view of state in this process, with the file on disk stale.
   * Silently accepting that would let a revoked push subscription — a
   * capability to wake someone's phone — survive a restart. So a failed
   * persist is retried a bounded number of times with backoff instead of
   * just logged and dropped. `unref()`ed so a store with a retry in flight
   * never keeps the process alive on its own.
   */
  private persistRetryTimer: NodeJS.Timeout | undefined;
  private persistRetryAttempt = 0;

  constructor(
    private readonly filePath: string,
    private readonly persistRetryDelaysMs: readonly number[] = DEFAULT_PERSIST_RETRY_DELAYS_MS,
  ) {}

  /**
   * Reads the file if it is there and usable. Never throws: an unreadable or
   * corrupt store is treated the way the browser treats unparseable
   * localStorage — fall back to empty — because a gateway that will not start
   * because of its notification file is worse than one that cannot notify.
   */
  async load(): Promise<void> {
    this.records = [];
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    if (raw.length > MAX_PUSH_STORE_BYTES) return;
    try {
      const file = storeFileSchema.safeParse(JSON.parse(raw));
      if (!file.success || file.data.version !== STORE_VERSION) return;
      // Per record, not all-or-nothing: one bad entry must not cost a user
      // every other device they enabled.
      const valid = file.data.subscriptions.flatMap((entry) => {
        const parsed = storedSubscriptionSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
      this.records = dedupeByEndpoint(valid).slice(-MAX_PUSH_SUBSCRIPTIONS);
    } catch {
      // Not JSON.
    }
  }

  list(): readonly StoredPushSubscription[] {
    return this.records;
  }

  /**
   * Claims an endpoint for a session, replacing any existing record for it.
   *
   * Rebinding rather than rejecting a duplicate is what makes sign-out
   * complete: a device that subscribed under a session which has since expired
   * re-registers under its current session, so the logout route can find and
   * drop it. It also absorbs the browser re-minting a subscription.
   */
  async upsert(record: StoredPushSubscription): Promise<void> {
    this.records = [
      ...this.records.filter((existing) => existing.endpoint !== record.endpoint),
      record,
    ].slice(-MAX_PUSH_SUBSCRIPTIONS);
    await this.persist();
  }

  async removeEndpoint(endpoint: string): Promise<boolean> {
    const remaining = this.records.filter((record) => record.endpoint !== endpoint);
    if (remaining.length === this.records.length) return false;
    this.records = remaining;
    await this.persist();
    return true;
  }

  /** Sign-out revocation. Expiry deliberately has no equivalent. */
  async removeSession(sessionId: string): Promise<number> {
    return this.removeWhere((record) => record.sessionId === sessionId);
  }

  /**
   * Device revocation. Unlike `removeSession` this reaches records whose
   * session is long gone, which is the ordinary case for a phone that is
   * asleep, or was paired before the last restart.
   */
  async removeDevice(deviceId: string): Promise<number> {
    return this.removeWhere((record) => record.deviceId === deviceId);
  }

  /**
   * Drops every record. For `devices --revoke all`, where the intent is that
   * no device may be woken and legacy records carrying no `deviceId` must go
   * too.
   */
  async removeAll(): Promise<number> {
    return this.removeWhere(() => true);
  }

  private async removeWhere(doomed: (record: StoredPushSubscription) => boolean): Promise<number> {
    const remaining = this.records.filter((record) => !doomed(record));
    const removed = this.records.length - remaining.length;
    // Never persists on a miss: the CLI opens this store on a file it may not
    // be able to read, which loads as empty, and a blind write would truncate
    // a store that was merely unreadable.
    if (!removed) return 0;
    this.records = remaining;
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    const snapshot = this.records.map((record) => ({ ...record }));
    const write = this.writes.then(() => this.writeAtomically(snapshot), () => this.writeAtomically(snapshot));
    // The tracked tail must never reject, or an earlier failure would reject
    // every later write that merely queued behind it.
    this.writes = write.catch(() => {});
    write.then(
      () => this.onPersistSucceeded(),
      () => this.onPersistFailed(),
    );
    return write;
  }

  private onPersistSucceeded(): void {
    this.cancelPersistRetry();
    this.persistRetryAttempt = 0;
  }

  /**
   * Re-attempts the write with backoff. Every mutation (`upsert`,
   * `removeEndpoint`, `removeSession`) already calls `persist()` again with
   * whatever `records` looks like at that moment, so this timer only matters
   * when nothing else touches the store in the meantime — the case a
   * revocation right before a quiet restart falls into.
   */
  private onPersistFailed(): void {
    this.cancelPersistRetry();
    if (this.persistRetryAttempt >= this.persistRetryDelaysMs.length) {
      // Retries exhausted. Say plainly what that means operationally rather
      // than leaving it implicit: the stale record is still on disk.
      console.error(
        "Could not persist a push subscription store change after repeated attempts; " +
          "a revoked push subscription may return after a restart.",
      );
      this.persistRetryAttempt = 0;
      return;
    }
    const delay = this.persistRetryDelaysMs[this.persistRetryAttempt];
    this.persistRetryAttempt += 1;
    this.persistRetryTimer = setTimeout(() => {
      this.persistRetryTimer = undefined;
      void this.persist();
    }, delay);
    this.persistRetryTimer.unref?.();
  }

  private cancelPersistRetry(): void {
    if (this.persistRetryTimer) {
      clearTimeout(this.persistRetryTimer);
      this.persistRetryTimer = undefined;
    }
  }

  private writeAtomically(records: StoredPushSubscription[]): Promise<void> {
    return writeSecretFileAtomically(this.filePath, JSON.stringify({ version: STORE_VERSION, subscriptions: records }, null, 2));
  }
}

function dedupeByEndpoint(records: StoredPushSubscription[]): StoredPushSubscription[] {
  const byEndpoint = new Map<string, StoredPushSubscription>();
  for (const record of records) byEndpoint.set(record.endpoint, record);
  return [...byEndpoint.values()];
}
