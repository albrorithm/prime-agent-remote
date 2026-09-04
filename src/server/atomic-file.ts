import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a file that holds a secret, atomically.
 *
 * A sibling temp file and a rename, mode 0600 throughout, in a directory
 * created 0700. A rename within one directory is atomic, so a crash mid-write
 * leaves the previous file rather than a truncated one — which matters here
 * more than usual, because every caller's loader treats an unparseable file as
 * empty rather than as an error. A truncated write would not fail loudly; it
 * would quietly unpair every device, or lose the pairing token.
 *
 * Every credential-bearing file the gateway owns comes through here: the
 * device store, the push store, the pairing token, the VAPID keypair and the
 * CLI's gateway state. Harden the write discipline once, in this function.
 *
 * `body` is written exactly as given. Callers differ on the trailing newline
 * (the two JSON stores write none, the three single-value files do), and that
 * is the caller's business rather than something to normalise here.
 */
export async function writeSecretFileAtomically(filePath: string, body: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
