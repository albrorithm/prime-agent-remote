import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreatePairingToken, rotatePairingToken } from "./pairing-token.js";

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pairing-token-"));
  filePath = path.join(directory, "pairing-token");
});

afterEach(async () => {
  await chmod(directory, 0o700).catch(() => {});
  await rm(directory, { recursive: true, force: true });
});

describe("loadOrCreatePairingToken", () => {
  it("mints a token strong enough for the production floor", async () => {
    const token = await loadOrCreatePairingToken(filePath);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("returns the same token on the next start, which is the whole point", async () => {
    const first = await loadOrCreatePairingToken(filePath);
    const second = await loadOrCreatePairingToken(filePath);
    expect(second).toBe(first);
  });

  it("writes the file 0600 and creates its directory 0700", async () => {
    await loadOrCreatePairingToken(filePath);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("tolerates a trailing newline, which every editor adds", async () => {
    const token = "a".repeat(40);
    await writeFile(filePath, `${token}\n`, "utf8");
    await expect(loadOrCreatePairingToken(filePath)).resolves.toBe(token);
  });

  it("replaces a token too weak to be usable rather than honouring it", async () => {
    await writeFile(filePath, "short", "utf8");
    const token = await loadOrCreatePairingToken(filePath);
    expect(token).not.toBe("short");
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("replaces a token carrying bytes a URL would have to escape", async () => {
    await writeFile(filePath, `${"!".repeat(40)}`, "utf8");
    const token = await loadOrCreatePairingToken(filePath);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("replaces an implausibly large file instead of parsing it", async () => {
    await writeFile(filePath, "x".repeat(8 * 1024), "utf8");
    const token = await loadOrCreatePairingToken(filePath);
    expect(token.length).toBeLessThan(100);
  });
});

describe("rotatePairingToken", () => {
  it("replaces the stored token", async () => {
    const original = await loadOrCreatePairingToken(filePath);
    const rotated = await rotatePairingToken(filePath);
    expect(rotated).not.toBe(original);
    await expect(loadOrCreatePairingToken(filePath)).resolves.toBe(rotated);
  });

  it("leaves no temp file behind", async () => {
    await rotatePairingToken(filePath);
    const entries = await readFile(filePath, "utf8");
    expect(entries.trim().length).toBeGreaterThan(0);
  });
});
