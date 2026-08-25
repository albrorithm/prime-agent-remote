import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WebSocketClient } from "ws";
import type { CellOutput } from "../protocol.js";
import type { GatewayConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { createGateway, stableStringify, type Gateway } from "./gateway.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

const ORIGIN = "https://gateway.example.test";
const PAIRING_TOKEN = "gateway-factory-test-token";

function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: new Set([ORIGIN]),
    pairingToken: PAIRING_TOKEN,
    generatedPairingToken: false,
    secureCookie: false,
    backend: "demo",
    primeModule: "unused-in-tests",
    sessionTtlMs: 60_000,
    ...overrides,
  };
}

interface TestGateway {
  gateway: Gateway;
  server: Server;
  port: number;
  baseUrl: string;
  tmpDir: string;
  staticRoot: string;
}

const active: TestGateway[] = [];

async function startGateway(options: {
  config?: Partial<GatewayConfig>;
  mutationLimiter?: SlidingWindowLimiter;
  staticRootName?: string;
  backend?: DemoBackend;
} = {}): Promise<TestGateway> {
  const tmpDir = await mkdtemp(join(tmpdir(), "gateway-test-"));
  const staticRoot = join(tmpDir, options.staticRootName ?? "static");
  const gateway = await createGateway(testConfig(options.config), {
    backend: options.backend ?? new DemoBackend(),
    staticRoot,
    mutationLimiter: options.mutationLimiter,
  });
  const server = createServer(gateway.requestListener);
  server.on("upgrade", gateway.upgradeListener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind a test port");
  const entry: TestGateway = {
    gateway,
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    tmpDir,
    staticRoot,
  };
  active.push(entry);
  return entry;
}

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (entry) => {
    await entry.gateway.shutdown();
    entry.server.closeAllConnections();
    entry.server.close();
    await rm(entry.tmpDir, { recursive: true, force: true });
  }));
});

interface PairedClient {
  cookie: string;
  csrfToken: string;
}

async function pairClient(t: TestGateway): Promise<PairedClient> {
  const response = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token: PAIRING_TOKEN }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Pairing did not return a cookie");
  return { cookie, csrfToken: body.csrfToken };
}

function mutationHeaders(client: PairedClient): Record<string, string> {
  return {
    Origin: ORIGIN,
    Cookie: client.cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": client.csrfToken,
  };
}

interface BootstrapBody {
  csrfToken: string;
  backend: string;
  catalog: {
    agents: Array<{
      id: string;
      attention: string | null;
      capabilities: { send: boolean; abort: boolean; resume: boolean };
    }>;
  };
}

async function bootstrap(t: TestGateway, client: PairedClient): Promise<BootstrapBody> {
  const response = await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } });
  expect(response.status).toBe(200);
  return await response.json() as BootstrapBody;
}

async function agentRevision(t: TestGateway, client: PairedClient, agentId: string): Promise<number> {
  const response = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/snapshot`, {
    headers: { Cookie: client.cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { revision: number }).revision;
}

function openSocket(t: TestGateway, client: PairedClient): WebSocketClient {
  return new WebSocketClient(`ws://127.0.0.1:${t.port}/ws/v1/events`, {
    headers: { Origin: ORIGIN, Cookie: client.cookie },
  });
}

function rawGet(t: TestGateway, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: t.port, path: rawPath, method: "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("stableStringify", () => {
  it("is insensitive to object key order at any depth", () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 3, y: 4 }], c: 5 } }))
      .toBe(stableStringify({ a: { c: 5, d: [2, { y: 4, z: 3 }] }, b: 1 }));
  });

  it("keeps array order significant", () => {
    expect(stableStringify({ items: [1, 2] })).not.toBe(stableStringify({ items: [2, 1] }));
  });
});

describe("gateway pairing and authentication", () => {
  it("rejects pairing from disallowed or missing origins", async () => {
    const t = await startGateway();
    const body = JSON.stringify({ token: PAIRING_TOKEN });
    const wrongOrigin = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: "https://untrusted.invalid", "Content-Type": "application/json" },
      body,
    });
    expect(wrongOrigin.status).toBe(403);
    const noOrigin = await rawGetlessPost(t, "/api/v1/auth/pair", body, { "Content-Type": "application/json" });
    expect(noOrigin).toBe(403);
  });

  it("400s malformed pairing bodies and 401s wrong tokens", async () => {
    const t = await startGateway();
    const invalid = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(invalid.status).toBe(400);
    const wrongToken = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(wrongToken.status).toBe(401);
  });

  it("401s API reads without a session and serves bootstrap with one", async () => {
    const t = await startGateway();
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`)).status).toBe(401);
    const client = await pairClient(t);
    const body = await bootstrap(t, client);
    expect(body.backend).toBe("demo");
    expect(body.catalog.agents.length).toBeGreaterThan(0);
  });
});

// fetch forbids removing the Origin header entirely, so raw requests stand in
// for a non-browser client that sends none.
function rawGetlessPost(t: TestGateway, path: string, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: t.port, path, method: "POST", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("gateway sign-out", () => {
  it("403s a sign-out that fails the CSRF check", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const response = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: client.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } })).status).toBe(200);
  });

  it("clears the cookie, kills the session, and answers a replay with 401", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const response = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedOut: true });
    expect(response.headers.get("set-cookie")).toBe("prime_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");

    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } })).status).toBe(401);
    const replay = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(replay.status).toBe(401);
  });

  it("closes every websocket bound to the session that signed out", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const sockets = [openSocket(t, client), openSocket(t, client)];
    await Promise.all(sockets.map((socket) => once(socket, "open")));

    const response = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(response.status).toBe(200);

    const closes = await Promise.all(sockets.map((socket) => once(socket, "close")));
    for (const [code] of closes) expect(code).toBe(1008);
  });

  it("leaves another session's websocket connected", async () => {
    const t = await startGateway();
    const [first, second] = [await pairClient(t), await pairClient(t)];
    const survivor = openSocket(t, second);
    await once(survivor, "open");

    await fetch(`${t.baseUrl}/api/v1/auth/logout`, { method: "POST", headers: mutationHeaders(first), body: "{}" });

    expect(survivor.readyState).toBe(WebSocketClient.OPEN);
    survivor.close();
  });
});

describe("gateway mutation guards", () => {
  it("403s mutations that fail the CSRF or Origin checks", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const body = JSON.stringify({ requestId: randomUUID(), cwd: "/" });

    const missingCsrf = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: client.cookie, "Content-Type": "application/json" },
      body,
    });
    expect(missingCsrf.status).toBe(403);

    const wrongCsrf = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { ...mutationHeaders(client), "X-CSRF-Token": "forged-token" },
      body,
    });
    expect(wrongCsrf.status).toBe(403);

    const wrongOrigin = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { ...mutationHeaders(client), Origin: "https://untrusted.invalid" },
      body,
    });
    expect(wrongOrigin.status).toBe(403);

    const noOrigin = await rawGetlessPost(t, "/api/v1/sessions", body, {
      Cookie: client.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": client.csrfToken,
    });
    expect(noOrigin).toBe(403);
  });

  it("429s mutations over the sliding window and sets Retry-After", async () => {
    const t = await startGateway({ mutationLimiter: new SlidingWindowLimiter(60_000, 2, 8) });
    const client = await pairClient(t);
    for (let index = 0; index < 2; index += 1) {
      const accepted = await fetch(`${t.baseUrl}/api/v1/sessions`, {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ requestId: randomUUID(), cwd: "/" }),
      });
      expect(accepted.status).toBe(202);
    }
    const limited = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), cwd: "/" }),
    });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Reads are not rate limited.
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } })).status).toBe(200);
  });

  it("lets a rate-limited session still sign out", async () => {
    const t = await startGateway({ mutationLimiter: new SlidingWindowLimiter(60_000, 1, 8) });
    const client = await pairClient(t);
    await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), cwd: "/" }),
    });
    const limited = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), cwd: "/" }),
    });
    expect(limited.status).toBe(429);

    // Revoking must never be the one request a session cannot make.
    const signedOut = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(signedOut.status).toBe(200);
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } })).status).toBe(401);
  });

  it("still requires CSRF to sign out when the limiter is bypassed", async () => {
    const t = await startGateway({ mutationLimiter: new SlidingWindowLimiter(60_000, 1, 8) });
    const client = await pairClient(t);

    const forged = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: client.cookie, Origin: t.baseUrl, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(forged.status).toBe(403);
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } })).status).toBe(200);
  });

  it("400s malformed JSON and schema-invalid bodies, 413s oversized ones", async () => {
    const t = await startGateway();
    const client = await pairClient(t);

    const malformed = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { title: string }).title).toBe("Invalid JSON");

    const invalid = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: "not-a-uuid", cwd: "/" }),
    });
    expect(invalid.status).toBe(400);

    const oversized = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), cwd: "/", pad: "x".repeat(1_100_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("replays identical retries regardless of key order and 409s real conflicts", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const agents = (await bootstrap(t, client)).catalog.agents;
    const agentId = agents.find((agent) => agent.capabilities.send)?.id;
    if (!agentId) throw new Error("No send-capable demo agent");
    const revision = await agentRevision(t, client, agentId);
    const messagesUrl = `${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/messages`;
    const requestId = randomUUID();

    const first = await fetch(messagesUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: `{"requestId":"${requestId}","expectedRevision":${revision},"text":"idempotent retry"}`,
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { requestId: string; revision: number };

    const replayed = await fetch(messagesUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: `{"text":"idempotent retry","expectedRevision":${revision},"requestId":"${requestId}"}`,
    });
    expect(replayed.status).toBe(202);
    expect(await replayed.json()).toEqual(firstBody);

    const mismatched = await fetch(messagesUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId, expectedRevision: revision, text: "different body" }),
    });
    expect(mismatched.status).toBe(409);

    const conflicting = await fetch(messagesUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 999_999, text: "stale revision" }),
    });
    expect(conflicting.status).toBe(409);
  });
});

describe("gateway API routes", () => {
  it("404s unknown routes, agents, attachments, and command catalogs", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const headers = { Cookie: client.cookie };

    const unknownRoute = await fetch(`${t.baseUrl}/api/v1/unknown`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(unknownRoute.status).toBe(404);
    expect(((await unknownRoute.json()) as { title: string }).title).toBe("API route not found");

    expect((await fetch(`${t.baseUrl}/api/v1/agents/no-such-agent/snapshot`, { headers })).status).toBe(404);
    expect((await fetch(`${t.baseUrl}/api/v1/attachments/no-such-attachment`, { headers })).status).toBe(404);
    expect((await fetch(`${t.baseUrl}/api/v1/agents/no-such-agent/commands`, { headers })).status).toBe(404);
  });

  it("lists directories and validates the requested path", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const headers = { Cookie: client.cookie };

    const listing = await fetch(`${t.baseUrl}/api/v1/directories`, { headers });
    expect(listing.status).toBe(200);
    const body = await listing.json() as { path: string; entries: unknown[] };
    expect(body.path).toBe("/");
    expect(body.entries.length).toBeGreaterThan(0);

    expect((await fetch(`${t.baseUrl}/api/v1/directories?path=relative%2Fpath`, { headers })).status).toBe(400);
    expect((await fetch(`${t.baseUrl}/api/v1/directories?path=%2Fno-such-dir`, { headers })).status).toBe(404);
  });

  it("creates sessions, serves command catalogs, and aborts agents", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const agents = (await bootstrap(t, client)).catalog.agents;
    const agentId = agents.find((agent) => agent.capabilities.send && agent.capabilities.abort)?.id;
    if (!agentId) throw new Error("No abortable demo agent");

    const created = await fetch(`${t.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), cwd: "/", name: "Factory test session" }),
    });
    expect(created.status).toBe(202);
    expect(((await created.json()) as { agentId: string }).agentId).toBeTruthy();

    const catalog = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/commands`, {
      headers: { Cookie: client.cookie },
    });
    expect(catalog.status).toBe(200);
    expect(((await catalog.json()) as { commands: unknown[] }).commands.length).toBeGreaterThan(0);

    const revision = await agentRevision(t, client, agentId);
    const aborted = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/abort`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: revision }),
    });
    expect(aborted.status).toBe(202);

    const unabortableId = agents.find((agent) => agent.capabilities.resume)?.id;
    if (!unabortableId) throw new Error("No resume-only demo agent");
    const forbidden = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(unabortableId)}/abort`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1 }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("serves cached cell output only to authenticated clients", async () => {
    const cell: CellOutput = {
      cellId: "cell_demo",
      code: "print('full output')",
      stdout: "full output\n",
      truncated: false,
    };
    class CellBackend extends DemoBackend {
      override cellOutput(id: string): CellOutput | null {
        return id === cell.cellId ? structuredClone(cell) : null;
      }
    }
    const t = await startGateway({ backend: new CellBackend() });

    const unauthenticated = await fetch(`${t.baseUrl}/api/v1/cells/${cell.cellId}`);
    expect(unauthenticated.status).toBe(401);

    const client = await pairClient(t);
    const headers = { Cookie: client.cookie };
    const unknown = await fetch(`${t.baseUrl}/api/v1/cells/no-such-cell`, { headers });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { title: string }).title).toBe("Cell output not found");

    const found = await fetch(`${t.baseUrl}/api/v1/cells/${cell.cellId}`, { headers });
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(found.headers.get("cache-control")).toBe("private, no-store");
    expect(await found.json()).toEqual(cell);
  });

  it("resolves attention requests and 404s unknown or already-resolved ones", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const agents = (await bootstrap(t, client)).catalog.agents;
    expect(agents.some((agent) => agent.attention === "dialog")).toBe(true);
    const respondUrl = `${t.baseUrl}/api/v1/attention/attention-demo-dialog/respond`;

    const unknown = await fetch(`${t.baseUrl}/api/v1/attention/no-such-attention/respond`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1, optionId: "confirm" }),
    });
    expect(unknown.status).toBe(404);

    const stale = await fetch(respondUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 999, optionId: "confirm" }),
    });
    expect(stale.status).toBe(409);

    const invalid = await fetch(respondUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1 }),
    });
    expect(invalid.status).toBe(400);

    const resolved = await fetch(respondUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1, optionId: "confirm" }),
    });
    expect(resolved.status).toBe(202);

    const gone = await fetch(respondUrl, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1, optionId: "confirm" }),
    });
    expect(gone.status).toBe(404);
  });
});

describe("gateway static serving", () => {
  async function withStaticFiles(t: TestGateway): Promise<string> {
    await mkdir(t.staticRoot, { recursive: true });
    await writeFile(join(t.staticRoot, "index.html"), "<!doctype html><title>Gateway index</title>");
    await writeFile(join(t.staticRoot, "app.css"), "body{}");
    const secretPath = join(t.tmpDir, "secret.txt");
    await writeFile(secretPath, "TOP-SECRET-CONTENT");
    return secretPath;
  }

  it("serves index.html at the root and assets with their MIME types", async () => {
    const t = await startGateway();
    await withStaticFiles(t);

    const index = await fetch(`${t.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("Gateway index");
    expect(index.headers.get("cache-control")).toBe("no-cache");

    const asset = await fetch(`${t.baseUrl}/app.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=3600");

    expect((await fetch(`${t.baseUrl}/missing.css`)).status).toBe(404);
  });

  it("rejects traversal attempts, plain and encoded, without leaking files", async () => {
    const t = await startGateway();
    const secretPath = await withStaticFiles(t);

    // The absolute-form request target yields a "//"-prefixed pathname whose
    // resolution escapes the static root; that one must die on the prefix
    // guard. The others must stay inside the root after URL normalization.
    for (const rawPath of [
      `http://127.0.0.1:${t.port}//etc/passwd`,
      `http://127.0.0.1:${t.port}/${secretPath}`,
      `/${secretPath}`,
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
    ]) {
      const response = await rawGet(t, rawPath);
      expect(response.status, rawPath).toBe(404);
      expect(response.body, rawPath).not.toContain("TOP-SECRET-CONTENT");
    }
  });

  it("explains a missing web build only for the index fallback", async () => {
    const t = await startGateway({ staticRootName: "never-built" });
    const index = await fetch(`${t.baseUrl}/`);
    expect(index.status).toBe(404);
    expect(((await index.json()) as { title: string }).title).toBe("Web build not found");

    const other = await fetch(`${t.baseUrl}/missing.js`);
    expect(other.status).toBe(404);
    expect(((await other.json()) as { title: string }).title).toBe("Not found");
  });
});
