import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DeviceStore,
  MAX_DEVICES,
  MAX_DEVICE_NAME_CHARS,
  formatDeviceToken,
  parseDeviceToken,
} from "./device-store.js";

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "device-store-"));
  filePath = path.join(directory, "devices.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("parseDeviceToken", () => {
  it("splits on the first dot", () => {
    expect(parseDeviceToken(formatDeviceToken("abc", "secret"))).toEqual({ id: "abc", secret: "secret" });
  });

  it("rejects tokens with no separator, an empty half, or non-base64url bytes", () => {
    for (const token of ["", ".", "abc", ".secret", "abc.", "ab c.secret", "abc.se cret", "a=b.secret"]) {
      expect(parseDeviceToken(token)).toBeNull();
    }
  });
});

describe("DeviceStore", () => {
  it("issues a usable credential and verifies it back", async () => {
    const store = new DeviceStore(filePath);
    const issued = await store.issue("phone");
    await expect(store.verify(issued.token)).resolves.toMatchObject({ id: issued.device.id, name: "phone" });
  });

  it("never writes the secret to disk", async () => {
    const store = new DeviceStore(filePath);
    const issued = await store.issue("phone");
    const secret = issued.token.slice(issued.token.indexOf(".") + 1);
    const raw = await readFile(filePath, "utf8");
    expect(secret.length).toBeGreaterThan(20);
    expect(raw).not.toContain(secret);
    expect(raw).toContain(issued.device.secretHash);
  });

  it("writes the store 0600, because it decides who may return", async () => {
    const store = new DeviceStore(filePath);
    await store.issue("phone");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a right id carrying a wrong secret", async () => {
    const store = new DeviceStore(filePath);
    const issued = await store.issue("phone");
    await expect(store.verify(formatDeviceToken(issued.device.id, "wrong-secret"))).resolves.toBeNull();
  });

  it("rejects an unknown id and a malformed token", async () => {
    const store = new DeviceStore(filePath);
    await store.issue("phone");
    await expect(store.verify(formatDeviceToken("not-a-device", "secret"))).resolves.toBeNull();
    await expect(store.verify("garbage")).resolves.toBeNull();
  });

  it("records the sighting so a device screen can say last used", async () => {
    const store = new DeviceStore(filePath);
    const issued = await store.issue("phone", new Date("2026-01-01T00:00:00.000Z"));
    const seen = await store.verify(issued.token, new Date("2026-02-02T00:00:00.000Z"));
    expect(seen?.lastSeenAt).toBe("2026-02-02T00:00:00.000Z");
    expect(seen?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("revokes one device without touching the others", async () => {
    const store = new DeviceStore(filePath);
    const first = await store.issue("phone");
    const second = await store.issue("tablet");
    await expect(store.revoke(first.device.id)).resolves.toBe(true);
    await expect(store.verify(first.token)).resolves.toBeNull();
    await expect(store.verify(second.token)).resolves.not.toBeNull();
  });

  it("reports a revoke that matched nothing", async () => {
    const store = new DeviceStore(filePath);
    await expect(store.revoke("never-existed")).resolves.toBe(false);
  });

  it("revokes every device at once", async () => {
    const store = new DeviceStore(filePath);
    const first = await store.issue("phone");
    await store.issue("tablet");
    await expect(store.revokeAll()).resolves.toBe(2);
    await expect(store.verify(first.token)).resolves.toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("truncates an over-long device name rather than refusing the pairing", async () => {
    const store = new DeviceStore(filePath);
    const issued = await store.issue("n".repeat(MAX_DEVICE_NAME_CHARS + 40));
    expect(issued.device.name).toHaveLength(MAX_DEVICE_NAME_CHARS);
  });

  it("keeps credentials working across a restart, which is the whole point", async () => {
    const first = new DeviceStore(filePath);
    const issued = await first.issue("phone");
    const second = new DeviceStore(filePath);
    await second.load();
    await expect(second.verify(issued.token)).resolves.toMatchObject({ id: issued.device.id });
  });

  it("bounds how many devices it keeps", async () => {
    const store = new DeviceStore(filePath);
    for (let index = 0; index < MAX_DEVICES + 5; index += 1) await store.issue(`device-${index}`);
    expect(store.list()).toHaveLength(MAX_DEVICES);
  });
});

describe("DeviceStore.load", () => {
  it("starts empty when the file is absent", async () => {
    const store = new DeviceStore(filePath);
    await store.load();
    expect(store.list()).toHaveLength(0);
  });

  it("drops one malformed record without unpairing the rest", async () => {
    const seed = new DeviceStore(filePath);
    const issued = await seed.issue("phone");
    const file = JSON.parse(await readFile(filePath, "utf8")) as { version: number; devices: unknown[] };
    file.devices.push({ id: "broken" });
    await writeFile(filePath, JSON.stringify(file));

    const store = new DeviceStore(filePath);
    await store.load();
    expect(store.list()).toHaveLength(1);
    await expect(store.verify(issued.token)).resolves.not.toBeNull();
  });

  it("ignores a store written by a future version", async () => {
    const seed = new DeviceStore(filePath);
    await seed.issue("phone");
    const file = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
    await writeFile(filePath, JSON.stringify({ ...file, version: 99 }));

    const store = new DeviceStore(filePath);
    await store.load();
    expect(store.list()).toHaveLength(0);
  });

  it("falls back to empty on unparseable content instead of failing startup", async () => {
    await writeFile(filePath, "{ not json");
    const store = new DeviceStore(filePath);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});
