import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSecretFileAtomically } from "./atomic-file.js";

let root: string;
let filePath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "atomic-file-"));
  filePath = path.join(root, "nested", "secret.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeSecretFileAtomically", () => {
  it("creates the directory, writes the body byte for byte, and leaves no temp file", async () => {
    await writeSecretFileAtomically(filePath, '{"version":1}');
    expect(await readFile(filePath, "utf8")).toBe('{"version":1}');
    expect(await readdir(path.dirname(filePath))).toEqual(["secret.json"]);
  });

  // These files hold a pairing token, device secret hashes, a VAPID private
  // key and the endpoints that can wake someone's phone.
  it("writes the file 0600 inside a 0700 directory", async () => {
    await writeSecretFileAtomically(filePath, "secret");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
  });

  it("replaces an existing file rather than appending to it", async () => {
    await writeSecretFileAtomically(filePath, "first");
    await writeSecretFileAtomically(filePath, "second");
    expect(await readFile(filePath, "utf8")).toBe("second");
  });

  it("cleans up the temp file and rethrows when the rename cannot land", async () => {
    // The temp file is written; the rename onto an existing directory is what
    // fails. That is the catch branch, and the temp file must not survive it.
    const occupied = path.join(root, "occupied");
    await mkdir(occupied);

    await expect(writeSecretFileAtomically(occupied, "body")).rejects.toThrow();
    expect((await stat(occupied)).isDirectory()).toBe(true);
    expect(await readdir(root)).toEqual(["occupied"]);
  });
});
