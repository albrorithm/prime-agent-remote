import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PersistQueue } from "./persist-queue.js";

/**
 * A phone is one subscription, and this gateway pairs with a handful of
 * devices at most. The bound exists so a rotating endpoint (browsers do
 * re-mint them) cannot grow the file without limit, not to ration devices.
 */
/**
 * One per device the device store can hold. A smaller bound evicted a live
 * phone's record the day the twenty-first device subscribed, silently, and
 * `docs/security.md` said no record was ever removed for being old.
 */
export const MAX_PUSH_SUBSCRIPTIONS = 32;
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
   * The paired device the claiming session descended from. Sessions die with
   * the process and the subscription does not, so the wake capability is
   * bound to the one credential a later revocation can still reach.
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

/** Push subscriptions survive gateway restarts and session expiry. */
export class PushSubscriptionStore {
  private records: StoredPushSubscription[] = [];
  private readonly file: PersistQueue;

  constructor(private readonly filePath: string, persistRetryDelaysMs?: readonly number[]) {
    this.file = new PersistQueue(filePath, () => JSON.stringify({ version: STORE_VERSION, subscriptions: this.records }, null, 2), {
      retryDelaysMs: persistRetryDelaysMs,
      onRetriesExhausted: () => console.error(
        "Could not persist a push subscription store change after repeated attempts; " +
          "a revoked push subscription may return after a restart.",
      ),
    });
  }

  /**
   * Reads the file if it is there and usable. Never throws: an unreadable or
   * corrupt store is treated the way the browser treats unparseable
   * localStorage — fall back to empty — because a gateway that will not start
   * because of its notification file is worse than one that cannot notify.
   */
  async load(options: { strict?: boolean } = {}): Promise<void> {
    this.records = [];
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      // Absent is empty. Unreadable is unknown, and a strict caller (the CLI,
      // about to report a revocation as applied) must not take it for empty.
      if (options.strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

  /** Whether the file has yet to catch up with a change already made here. */
  get hasPendingWrite(): boolean {
    return this.file.hasPendingWrite;
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
    if (remaining.length === this.records.length && !this.file.hasPendingWrite) return false;
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
    // Never persists on a miss, unless a write is already owed: the CLI opens
    // this store on a file it may not be able to read, which loads as empty,
    // and a blind write would truncate a store that was merely unreadable.
    if (!removed && !this.file.hasPendingWrite) return 0;
    this.records = remaining;
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    return this.file.persist();
  }
}

function dedupeByEndpoint(records: StoredPushSubscription[]): StoredPushSubscription[] {
  const byEndpoint = new Map<string, StoredPushSubscription>();
  for (const record of records) byEndpoint.set(record.endpoint, record);
  return [...byEndpoint.values()];
}
