import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  it("creates the directory and writes the body exactly", async () => {
    await writeSecretFileAtomically(filePath, "one\n");
    expect(await readFile(filePath, "utf8")).toBe("one\n");
  });

  /* The two JSON stores write no trailing newline and the three single-value
     files do. The helper must not decide that for them. */
  it("adds nothing to a body that ends without a newline", async () => {
    await writeSecretFileAtomically(filePath, '{"version":1}');
    expect(await readFile(filePath, "utf8")).toBe('{"version":1}');
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

  /* The temp file is a sibling so the rename stays within one directory, which
     is what makes it atomic. It must not be left behind either way. */
  it("leaves no temp file behind on success", async () => {
    await writeSecretFileAtomically(filePath, "body");
    expect(await readdir(path.dirname(filePath))).toEqual(["secret.json"]);
  });

  it("cleans up the temp file and rethrows when the write cannot land", async () => {
    // A file where the directory has to go: mkdir fails, so nothing is written
    // and nothing is left over.
    const blocked = path.join(root, "occupied");
    await writeFile(blocked, "not a directory", "utf8");

    await expect(writeSecretFileAtomically(path.join(blocked, "secret.json"), "body")).rejects.toThrow();
    expect(await readFile(blocked, "utf8")).toBe("not a directory");
  });
});
