import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PersistQueue } from "./persist-queue.js";

/**
 * A household pairs a handful of phones, not a fleet. The bound stops a
 * runaway pairing loop from growing the file without limit; it is not a
 * licence check.
 */
export const MAX_DEVICES = 32;
export const MAX_DEVICE_NAME_CHARS = 64;
/** Anything larger is treated as corrupt instead of parsed. */
export const MAX_DEVICE_STORE_BYTES = 256 * 1024;
const STORE_VERSION = 1;

const ID_BYTES = 16;
const SECRET_BYTES = 32;

export interface StoredDevice {
  id: string;
  name: string;
  /**
   * sha256 of the device secret, base64url. The secret itself is shown once,
   * to one browser, and is never written down: this file is a list of which
   * devices may return, not a list of credentials that let anyone become one.
   */
  secretHash: string;
  createdAt: string;
  lastSeenAt: string;
}

const storedDeviceSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(MAX_DEVICE_NAME_CHARS),
  secretHash: z.string().min(1).max(128),
  createdAt: z.string().min(1).max(64),
  lastSeenAt: z.string().min(1).max(64),
}).strict();

const storeFileSchema = z.object({
  version: z.number().int(),
  devices: z.array(z.unknown()).max(MAX_DEVICES * 4),
});

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

/**
 * Compares the presented secret against a stored hash in constant time.
 * Hashing both sides first keeps the compared buffers the same length, so the
 * comparison cannot leak the secret's length either.
 */
function secretMatches(secret: string, secretHash: string): boolean {
  const presented = createHash("sha256").update(hashSecret(secret)).digest();
  const stored = createHash("sha256").update(secretHash).digest();
  return timingSafeEqual(presented, stored);
}

/** `id.secret`. The dot is safe: both halves are base64url, which has no dot. */
export function formatDeviceToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseDeviceToken(token: string): { id: string; secret: string } | null {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/u.test(id) || !/^[A-Za-z0-9_-]+$/u.test(secret)) return null;
  return { id, secret };
}

export interface IssuedDevice {
  device: StoredDevice;
  /** Shown to exactly one browser, once. Not recoverable from the store. */
  token: string;
}

/**
 * Which devices have been paired, and may therefore start a new session
 * without the pairing token again.
 *
 * This exists because sessions are in-memory and die with the process. Without
 * it, restarting the gateway signs out every phone in the house and each one
 * has to be handed the pairing token a second time — so operators keep the
 * token somewhere convenient, which is the opposite of what a bootstrap secret
 * wants. A device credential is narrower than the pairing token in every way
 * that matters: it authorises one device, it can be revoked alone, and it is
 * stored as a hash rather than in the clear.
 */
export class DeviceStore {
  private devices: StoredDevice[] = [];
  private readonly file: PersistQueue;

  constructor(private readonly filePath: string, persistRetryDelaysMs?: readonly number[]) {
    this.file = new PersistQueue(filePath, () => JSON.stringify({ version: STORE_VERSION, devices: this.devices }, null, 2), {
      retryDelaysMs: persistRetryDelaysMs,
      onRetriesExhausted: () => console.error(
        "Could not persist the device store after repeated attempts; a revoked device may return after a restart.",
      ),
    });
  }

  /**
   * Never throws unless `strict`. A corrupt store costs everyone one
   * re-pairing, which is recoverable; a gateway that refuses to start because
   * of it is not. The CLI asks for `strict` because it is about to say
   * "revoked", and an unreadable file must not read as an empty one.
   */
  async load(options: { strict?: boolean } = {}): Promise<void> {
    this.devices = [];
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      // Absent is empty. Unreadable is unknown, and a strict caller (the CLI,
      // about to report a revocation as applied) must not take it for empty.
      if (options.strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (raw.length > MAX_DEVICE_STORE_BYTES) return;
    try {
      const file = storeFileSchema.safeParse(JSON.parse(raw));
      if (!file.success || file.data.version !== STORE_VERSION) return;
      // Per record, so one bad entry does not unpair every other phone.
      const valid = file.data.devices.flatMap((entry) => {
        const parsed = storedDeviceSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
      this.devices = dedupeById(valid).slice(-MAX_DEVICES);
    } catch {
      // Not JSON.
    }
  }

  list(): readonly StoredDevice[] {
    return this.devices;
  }

  /**
   * Mints a credential for a newly paired device. The secret is returned and
   * then forgotten; only its hash is kept.
   */
  async issue(name: string, now = new Date()): Promise<IssuedDevice> {
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const timestamp = now.toISOString();
    const device: StoredDevice = {
      id: randomBytes(ID_BYTES).toString("base64url"),
      name: name.slice(0, MAX_DEVICE_NAME_CHARS),
      secretHash: hashSecret(secret),
      createdAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.devices = [...this.devices, device].slice(-MAX_DEVICES);
    await this.persist();
    return { device, token: formatDeviceToken(device.id, secret) };
  }

  /**
   * Verifies a presented token. Returns the device on success and records the
   * sighting, which is what makes a device-management screen able to say
   * "last used" rather than only "created".
   */
  async verify(token: string, now = new Date()): Promise<StoredDevice | null> {
    const parsed = parseDeviceToken(token);
    if (!parsed) return null;
    const device = this.devices.find((candidate) => candidate.id === parsed.id);
    if (!device || !secretMatches(parsed.secret, device.secretHash)) return null;
    device.lastSeenAt = now.toISOString();
    // A timestamp the disk would not take is not a reason to refuse a valid
    // credential: the queue retries in the background and says so if it gives
    // up. `issue` is different — a credential not on disk must not be handed
    // out — and keeps its rejection.
    await this.persist().catch(() => {});
    /* Re-checked after the write, not before it. `revoke` removes the device
       from this array synchronously and only then awaits its own write, so a
       revocation landing while this one is in flight leaves the device gone
       from the store but still held here. Returning it anyway minted a session
       for a credential that no longer existed — and because the revoke handler
       had already collected its list of sessions to reap, that session was
       reachable by nothing: the device is absent from the device list, so
       revoking it again answers 404, and it kept full access until the session
       TTL expired or the gateway restarted.

       Identity, not id: revoke rebuilds the array while keeping the surviving
       objects, so this asks exactly "is this still paired". */
    return this.devices.includes(device) ? device : null;
  }

  /** Revocation is removal: there is nothing a revoked record would be for. */
  async revoke(id: string): Promise<boolean> {
    const remaining = this.devices.filter((device) => device.id !== id);
    if (remaining.length === this.devices.length) {
      if (this.file.hasPendingWrite) await this.persist();
      return false;
    }
    this.devices = remaining;
    await this.persist();
    return true;
  }

  /** Rotating the pairing token deliberately does not do this. */
  async revokeAll(): Promise<number> {
    const removed = this.devices.length;
    if (!removed && !this.file.hasPendingWrite) return 0;
    this.devices = [];
    await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    return this.file.persist();
  }
}

function dedupeById(devices: StoredDevice[]): StoredDevice[] {
  const byId = new Map<string, StoredDevice>();
  for (const device of devices) byId.set(device.id, device);
  return [...byId.values()];
}
