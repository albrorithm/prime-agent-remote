import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** 32 bytes base64url is 43 characters, comfortably over the production floor. */
const TOKEN_BYTES = 32;
/** Anything larger is treated as corrupt rather than parsed. */
const MAX_TOKEN_FILE_BYTES = 4 * 1024;
const MIN_USABLE_TOKEN_CHARS = 32;

function isUsable(token: string): boolean {
  return token.length >= MIN_USABLE_TOKEN_CHARS && /^[A-Za-z0-9_-]+$/u.test(token);
}

/**
 * Reads the gateway's own pairing token, minting and persisting one the first
 * time.
 *
 * Before this, an unconfigured gateway generated a fresh token on every start,
 * so every restart invalidated the one thing a new device needs. The usual
 * workaround is to pin PRIME_WEB_PAIRING_TOKEN in a shell profile or a unit
 * file, which puts a long-lived secret in the process environment where any
 * `ps` can read it. A file the gateway owns at mode 0600 is strictly better,
 * and it lets the CLI print the token without knowing how the gateway was
 * started.
 *
 * A file that is missing, unreadable, or holds something unusable is replaced
 * rather than treated as an error: the failure mode is one re-pairing, and a
 * gateway that will not start because of its token file is worse.
 */
export async function loadOrCreatePairingToken(filePath: string): Promise<string> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.length <= MAX_TOKEN_FILE_BYTES) {
      const token = raw.trim();
      if (isUsable(token)) return token;
    }
  } catch {
    // Absent or unreadable; mint one below.
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await writeTokenAtomically(filePath, token);
  return token;
}

/** Invalidates every unpaired setup link. Paired devices are unaffected. */
export async function rotatePairingToken(filePath: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await writeTokenAtomically(filePath, token);
  return token;
}

async function writeTokenAtomically(filePath: string, token: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
