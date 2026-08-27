import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAPID_SUBJECT } from "./config.js";
import { generateVapidKeys, loadOrCreateVapidKeys } from "./vapid-keys.js";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "prime-vapid-"));
}

describe("generateVapidKeys", () => {
  it("produces the raw encodings a push service and a browser both expect", () => {
    const keys = generateVapidKeys();
    const publicBytes = Buffer.from(keys.publicKey, "base64url");
    // 65 bytes behind an 0x04 tag is the uncompressed P-256 point. The browser
    // rejects anything else outright, and `config.ts` checks the same lengths.
    expect(publicBytes.byteLength).toBe(65);
    expect(publicBytes[0]).toBe(0x04);
    expect(Buffer.from(keys.privateKey, "base64url").byteLength).toBe(32);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a pair that actually belongs together", () => {
    // Length checks pass just as happily on two unrelated keys, which would
    // fail only at send time, on a phone, with no error anyone sees. So sign
    // with the private half and verify with the public one.
    const keys = generateVapidKeys();
    const publicBytes = Buffer.from(keys.publicKey, "base64url");
    const jwk = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: publicBytes.subarray(1, 33).toString("base64url"),
      y: publicBytes.subarray(33).toString("base64url"),
    };
    const privateKey = createPrivateKey({ key: { ...jwk, d: keys.privateKey }, format: "jwk" });
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });

    const signer = createSign("SHA256");
    signer.update("prime-agent-remote");
    const signature = signer.sign(privateKey);

    const verifier = createVerify("SHA256");
    verifier.update("prime-agent-remote");
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  it("does not repeat itself", () => {
    expect(generateVapidKeys().privateKey).not.toBe(generateVapidKeys().privateKey);
  });
});

describe("loadOrCreateVapidKeys", () => {
  it("mints once and returns the same pair afterwards", async () => {
    const directory = await scratch();
    const file = path.join(directory, "vapid-keys.json");

    const first = await loadOrCreateVapidKeys(file);
    const second = await loadOrCreateVapidKeys(file);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
    expect(first.subject).toBe(DEFAULT_VAPID_SUBJECT);
  });

  it("keeps the private half out of any other process's reach", async () => {
    const directory = await scratch();
    const file = path.join(directory, "vapid-keys.json");
    await loadOrCreateVapidKeys(file);
    // The whole argument for a file over an environment variable is that `ps`
    // cannot read it. That only holds at 0600.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("carries the subject through without storing it", async () => {
    const directory = await scratch();
    const file = path.join(directory, "vapid-keys.json");
    const keys = await loadOrCreateVapidKeys(file, "mailto:operator@example.test");
    expect(keys.subject).toBe("mailto:operator@example.test");
    // Stored keys are identity; the subject is configuration, and baking it in
    // would make PRIME_WEB_VAPID_SUBJECT stop taking effect after first run.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    });
    expect((await loadOrCreateVapidKeys(file, "https://example.test/ops")).subject).toBe("https://example.test/ops");
  });

  it("replaces a corrupt or truncated file rather than refusing to start", async () => {
    const directory = await scratch();
    const file = path.join(directory, "vapid-keys.json");
    for (const damaged of ["", "{", "null", '{"publicKey":"short","privateKey":"short"}', '{"publicKey":"AAAA"}']) {
      await writeFile(file, damaged, "utf8");
      const keys = await loadOrCreateVapidKeys(file);
      expect(Buffer.from(keys.publicKey, "base64url").byteLength).toBe(65);
      expect(Buffer.from(keys.privateKey, "base64url").byteLength).toBe(32);
    }
  });

  it("refuses a file too large to be a keypair instead of parsing it", async () => {
    const directory = await scratch();
    const file = path.join(directory, "vapid-keys.json");
    const honest = await loadOrCreateVapidKeys(file);
    await writeFile(file, JSON.stringify({ ...honest, padding: "x".repeat(8 * 1024) }), "utf8");
    expect((await loadOrCreateVapidKeys(file)).publicKey).not.toBe(honest.publicKey);
  });
});
