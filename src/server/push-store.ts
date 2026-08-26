import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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
  createdAt: string;
}

const storedSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_CHARS).url(),
  p256dh: z.string().min(1).max(MAX_PUSH_KEY_CHARS),
  auth: z.string().min(1).max(MAX_PUSH_KEY_CHARS),
  sessionId: z.string().min(1).max(256),
  createdAt: z.string().min(1).max(64),
}).strict();

const storeFileSchema = z.object({
  version: z.number().int(),
  subscriptions: z.array(z.unknown()).max(MAX_PUSH_SUBSCRIPTIONS * 4),
});

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

  constructor(private readonly filePath: string) {}

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
    const remaining = this.records.filter((record) => record.sessionId !== sessionId);
    const removed = this.records.length - remaining.length;
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
    return write;
  }

  /**
   * Writes a sibling temp file and renames over the target: a rename within
   * one directory is atomic, so a crash mid-write leaves the previous file
   * intact rather than a truncated one that `load` would discard. Mode 0600
   * throughout — these records are a capability to wake someone's phone.
   */
  private async writeAtomically(records: StoredPushSubscription[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${randomBytes(6).toString("hex")}.tmp`);
    const body = JSON.stringify({ version: STORE_VERSION, subscriptions: records }, null, 2);
    try {
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

function dedupeByEndpoint(records: StoredPushSubscription[]): StoredPushSubscription[] {
  const byEndpoint = new Map<string, StoredPushSubscription>();
  for (const record of records) byEndpoint.set(record.endpoint, record);
  return [...byEndpoint.values()];
}
