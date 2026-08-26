import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WebSocketClient } from "ws";
import type { AttentionRequest, CellOutput } from "../protocol.js";
import { BackendCapabilityError, type AttentionListener } from "./backend.js";
import type { GatewayConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { createGateway, stableStringify, type Gateway } from "./gateway.js";
import { PushService, type PushSender } from "./push-service.js";
import { PushSubscriptionStore } from "./push-store.js";
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
    // startGateway always overrides this with a path inside the test's own
    // temp directory; the default only exists to satisfy the type.
    webPushStorePath: join(tmpdir(), "prime-gateway-test-unused-push-store.json"),
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
  pushService?: PushService;
} = {}): Promise<TestGateway> {
  const tmpDir = await mkdtemp(join(tmpdir(), "gateway-test-"));
  const staticRoot = join(tmpDir, options.staticRootName ?? "static");
  const gateway = await createGateway(testConfig({
    webPushStorePath: join(tmpDir, "push-subscriptions.json"),
    ...options.config,
  }), {
    backend: options.backend ?? new DemoBackend(),
    staticRoot,
    mutationLimiter: options.mutationLimiter,
    pushService: options.pushService,
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
  push: { enabled: boolean; publicKey: string | null };
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

  it("renames an agent, rejects a malformed name, and maps a refused capability to 403", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const agents = (await bootstrap(t, client)).catalog.agents;
    const agentId = agents.find((agent) => agent.capabilities.rename)?.id;
    if (!agentId) throw new Error("No renameable demo agent");

    const revision = await agentRevision(t, client, agentId);
    const renamed = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/rename`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: revision, name: "Renamed by the gateway test" }),
    });
    expect(renamed.status).toBe(202);
    const after = (await bootstrap(t, client)).catalog.agents.find((agent) => agent.id === agentId);
    expect(after?.name).toBe("Renamed by the gateway test");

    // A name is a label in a list, so the schema refuses one that is not.
    for (const name of ["", "   ", "two\nlines", "x".repeat(201)]) {
      const rejected = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/rename`, {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ requestId: randomUUID(), expectedRevision: await agentRevision(t, client, agentId), name }),
      });
      expect(rejected.status, JSON.stringify(name)).toBe(400);
    }
  });

  it("answers a backend that refuses to rename with 403 rather than 500", async () => {
    // The UI decides what to offer from the capability bits, but the gateway
    // must still turn a backend's refusal into a refusal — not an error.
    class RefusingBackend extends DemoBackend {
      override async rename(): Promise<never> {
        throw new BackendCapabilityError("This agent cannot be renamed");
      }
    }
    const t = await startGateway({ backend: new RefusingBackend() });
    const client = await pairClient(t);
    const agentId = (await bootstrap(t, client)).catalog.agents[0]!.id;
    const forbidden = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/rename`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: await agentRevision(t, client, agentId),
        name: "Nope",
      }),
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

const VAPID = {
  publicKey: "BF1JW243veaons7uO0bcdtRHXVUTVJ74A_OzX7wiGhY114OpWvn0BOBrfXu2AhV3cmc0Nrb_LIRZHbFY4L8Xmgw",
  privateKey: "IPDx2j8nr-ShPjNWSqXsCAK3fA0W2cM78tjLvtG0jLA",
  subject: "mailto:operator@example.test",
};

function subscriptionBody(endpoint = "https://push.example.test/device-one") {
  return {
    requestId: randomUUID(),
    subscription: { endpoint, keys: { p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU", auth: "3v0fHqQhH3xQ1r6mB3dOsg" } },
  };
}

function pushRequest(t: TestGateway, client: PairedClient, action: "subscribe" | "unsubscribe", body: unknown) {
  return fetch(`${t.baseUrl}/api/v1/push/${action}`, {
    method: "POST",
    headers: mutationHeaders(client),
    body: JSON.stringify(body),
  });
}

describe("push subscription routes", () => {
  it("advertises push as off when the gateway has no VAPID keys", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    expect((await bootstrap(t, client)).push).toEqual({ enabled: false, publicKey: null });
  });

  it("advertises the application server key when push is configured", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const client = await pairClient(t);
    expect((await bootstrap(t, client)).push).toEqual({ enabled: true, publicKey: VAPID.publicKey });
  });

  // The default deployment has no keys. Refusing here is what keeps the
  // browser from handing over a permission this gateway can never act on.
  it("refuses a subscription when push is not configured", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const response = await pushRequest(t, client, "subscribe", subscriptionBody());
    expect(response.status).toBe(503);
    expect(t.gateway.pushStore.list()).toEqual([]);
  });

  it("stores a subscription bound to the requesting session", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const client = await pairClient(t);
    const response = await pushRequest(t, client, "subscribe", subscriptionBody());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(t.gateway.pushStore.list()).toHaveLength(1);
    expect(t.gateway.pushStore.list()[0].endpoint).toBe("https://push.example.test/device-one");
  });

  it("inherits the mutation gate: Origin, CSRF, and request-ID binding", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const client = await pairClient(t);

    const noCsrf = await fetch(`${t.baseUrl}/api/v1/push/subscribe`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: client.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(subscriptionBody()),
    });
    expect(noCsrf.status).toBe(403);

    const unauthenticated = await fetch(`${t.baseUrl}/api/v1/push/subscribe`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(subscriptionBody()),
    });
    expect(unauthenticated.status).toBe(401);

    const body = subscriptionBody();
    expect((await pushRequest(t, client, "subscribe", body)).status).toBe(202);
    expect((await pushRequest(t, client, "subscribe", body)).status).toBe(202);
    expect(t.gateway.pushStore.list()).toHaveLength(1);

    const rebound = await pushRequest(t, client, "subscribe", {
      ...body,
      subscription: { ...body.subscription, endpoint: "https://push.example.test/other" },
    });
    expect(rebound.status).toBe(409);
  });

  it("rejects a malformed subscription", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const client = await pairClient(t);
    for (const body of [
      { requestId: randomUUID(), subscription: { endpoint: "not-a-url", keys: { p256dh: "k", auth: "a" } } },
      { requestId: randomUUID(), subscription: { endpoint: "https://push.example.test/x" } },
      { requestId: "not-a-uuid", subscription: subscriptionBody().subscription },
      // Strict: `toJSON()` carries expirationTime, which the gateway did not ask for.
      { requestId: randomUUID(), subscription: { ...subscriptionBody().subscription, expirationTime: null } },
    ]) {
      expect((await pushRequest(t, client, "subscribe", body)).status).toBe(400);
    }
    expect(t.gateway.pushStore.list()).toEqual([]);
  });

  it("unsubscribes an endpoint, and succeeds for one it never held", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const client = await pairClient(t);
    await pushRequest(t, client, "subscribe", subscriptionBody());

    const unknown = await pushRequest(t, client, "unsubscribe", {
      requestId: randomUUID(),
      endpoint: "https://push.example.test/never-seen",
    });
    expect(unknown.status).toBe(202);
    expect(t.gateway.pushStore.list()).toHaveLength(1);

    const removed = await pushRequest(t, client, "unsubscribe", {
      requestId: randomUUID(),
      endpoint: "https://push.example.test/device-one",
    });
    expect(removed.status).toBe(202);
    expect(t.gateway.pushStore.list()).toEqual([]);
  });

  // The asymmetry that makes push worth having: a TTL lapse must leave the
  // subscription alive, or push stops working overnight.
  it("revokes on sign-out but not on session expiry", async () => {
    const t = await startGateway({ config: { webPush: VAPID, sessionTtlMs: 150 } });
    const expiring = await pairClient(t);
    await pushRequest(t, expiring, "subscribe", subscriptionBody("https://push.example.test/overnight"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: expiring.cookie } })).status).toBe(401);
    expect(t.gateway.pushStore.list()).toHaveLength(1);

    // The device re-registers under its new session, which is what lets the
    // sign-out below find a record the expired session originally created.
    const client = await pairClient(t);
    await pushRequest(t, client, "subscribe", subscriptionBody("https://push.example.test/overnight"));
    await pushRequest(t, client, "subscribe", subscriptionBody("https://push.example.test/second-device"));

    const signOut = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(signOut.status).toBe(200);
    expect(t.gateway.pushStore.list()).toEqual([]);
  });

  it("leaves another session's subscriptions alone on sign-out", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const leaving = await pairClient(t);
    const staying = await pairClient(t);
    await pushRequest(t, leaving, "subscribe", subscriptionBody("https://push.example.test/leaving"));
    await pushRequest(t, staying, "subscribe", subscriptionBody("https://push.example.test/staying"));

    await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(leaving),
      body: "{}",
    });
    expect(t.gateway.pushStore.list().map((record) => record.endpoint))
      .toEqual(["https://push.example.test/staying"]);
  });
});

/**
 * The demo backend never raises attention, so this adds the hook the prime
 * backend calls from `publishAttentionAdded`.
 */
class AttentionRaisingBackend extends DemoBackend {
  private readonly listeners: AttentionListener[] = [];

  onAttentionAdded(listener: AttentionListener): void {
    this.listeners.push(listener);
  }

  raise(attention: AttentionRequest): void {
    for (const listener of this.listeners) listener(attention);
  }
}

describe("attention fan-out to push", () => {
  it("pushes the session name and attention kind, and nothing the daemon wrote", async () => {
    const sent: string[] = [];
    const sender: PushSender = async (_subscription, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    };
    const storeDir = await mkdtemp(join(tmpdir(), "gateway-fanout-"));
    try {
      const store = new PushSubscriptionStore(join(storeDir, "push-subscriptions.json"));
      await store.load();
      await store.upsert({
        endpoint: "https://push.example.test/phone",
        p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU",
        auth: "3v0fHqQhH3xQ1r6mB3dOsg",
        sessionId: "session-a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const backend = new AttentionRaisingBackend();
      await startGateway({
        config: { webPush: VAPID },
        backend,
        pushService: new PushService(store, VAPID, sender),
      });

      backend.raise({
        id: "attention-9",
        agentId: "child-review",
        kind: "dialog",
        title: "SENTINEL-daemon-authored-title",
        detail: "SENTINEL-daemon-authored-detail",
        revision: 3,
        options: [{ id: "confirm", label: "SENTINEL-daemon-authored-option", tone: "safe" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      expect(sent[0]).not.toContain("SENTINEL");
      expect(JSON.parse(sent[0])).toMatchObject({
        // "Security reviewer" is the demo agent that carries attention, and
        // the badge counts it once across the whole catalog.
        title: "Security reviewer",
        body: "Waiting on your decision",
        agentId: "child-review",
        attentionId: "attention-9",
        badge: 1,
      });
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("stays silent when the gateway has no VAPID keys", async () => {
    const backend = new AttentionRaisingBackend();
    const t = await startGateway({ backend });
    expect(() => backend.raise({
      id: "attention-9",
      agentId: "child-review",
      kind: "dialog",
      title: "Anything",
      revision: 3,
      options: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    })).not.toThrow();
    expect(t.gateway.pushStore.list()).toEqual([]);
  });
});
