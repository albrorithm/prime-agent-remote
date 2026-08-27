import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WebSocketClient } from "ws";
import type { AgentSnapshot, AgentSummary, AttentionRequest, CellOutput } from "../protocol.js";
import { BackendCapabilityError, type AttentionListener } from "./backend.js";
import { DEFAULT_VAPID_SUBJECT, type GatewayConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { EventHub } from "./event-hub.js";
import { createGateway, stableStringify, type Gateway } from "./gateway.js";
import { PushService, type PushSender } from "./push-service.js";
import { PushSubscriptionStore } from "./push-store.js";
import { MAX_PAIR_ATTEMPTS_PER_CLIENT } from "./auth.js";
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
    // The gateway itself never mints keys — `index.ts` resolves them before
    // this point — so these only exist to satisfy the type.
    generatedWebPush: false,
    webPushSubject: DEFAULT_VAPID_SUBJECT,
    vapidKeysPath: join(tmpdir(), "prime-gateway-test-unused-vapid-keys.json"),
    webPushStorePath: join(tmpdir(), "prime-gateway-test-unused-push-store.json"),
    pairingTokenPath: join(tmpdir(), "prime-gateway-test-unused-pairing-token"),
    gatewayStatePath: join(tmpdir(), "prime-gateway-test-unused-state.json"),
    deviceStorePath: join(tmpdir(), "prime-gateway-test-unused-devices.json"),
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

/**
 * A DemoBackend that registers agent streams the way PrimeBackend does:
 * lazily, as a side effect of projecting a snapshot.
 *
 * DemoBackend registers every stream in initialize(), which is exactly the
 * state the transcript bug cannot occur in — so a test built on it proves
 * nothing about the bug. This stands in for the real backend: the agent is in
 * the catalog from the start, its stream does not exist until someone asks for
 * its snapshot, and after a restart the hub holds `catalog` and nothing else.
 */
class LazyStreamBackend extends DemoBackend {
  private lazyHub!: EventHub;

  override async initialize(hub: EventHub): Promise<void> {
    await super.initialize(hub);
    this.lazyHub = hub;
    // Undo the eager registration: only `catalog` survives a fresh start.
    for (const agent of this.catalog().agents) hub.unregister(`agent:${agent.id}`);
  }

  override async agentSnapshot(agentId: string): Promise<AgentSnapshot | null> {
    const snapshot = await super.agentSnapshot(agentId);
    if (snapshot && !this.lazyHub.has(`agent:${agentId}`)) {
      this.lazyHub.register(`agent:${agentId}`, snapshot);
    }
    return snapshot;
  }
}

/**
 * A LazyStreamBackend whose snapshot projection can be held open.
 *
 * The warmup window is the whole bug: on a real gateway it is however long it
 * takes to parse a multi-megabyte session file line by line, and a phone is
 * perfectly capable of speaking twice inside it. An ungated backend resolves
 * in a microtask, so a test built on one closes the window before it can send
 * the second frame and passes with the fix reverted.
 */
class GatedLazyStreamBackend extends LazyStreamBackend {
  snapshotCalls = 0;
  private release: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  hold(): void {
    this.gate = new Promise<void>((resolve) => { this.release = resolve; });
  }

  open(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  override async agentSnapshot(agentId: string): Promise<AgentSnapshot | null> {
    this.snapshotCalls += 1;
    if (this.gate) await this.gate;
    return await super.agentSnapshot(agentId);
  }
}

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
    // Into the test's own directory for the same reason as the push store: a
    // shared path would let one test's paired devices reach another's.
    deviceStorePath: join(tmpDir, "devices.json"),
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
  // The real summary type, not a hand-written subset: this drifted behind the
  // wire contract once already, and every field the tests read has to be added
  // by hand when it does.
  catalog: { agents: AgentSummary[] };
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

/**
 * Round-trips a ping so the server has provably handled every frame sent
 * before it. `socket.send` returns long before the gateway reads the frame, so
 * a warmup test that opens its gate straight after a send is racing its own
 * subject and can pass with the fix reverted.
 */
async function settleSocket(socket: WebSocketClient, frames: Record<string, unknown>[]): Promise<void> {
  const before = frames.length;
  socket.send(JSON.stringify({ type: "ping", version: 1 }));
  await vi.waitFor(() => expect(frames.slice(before).some((frame) => frame.type === "pong")).toBe(true));
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
    // Both credentials are cleared with the attributes they were set with, or
    // the browser keeps the originals. Sign-out revokes the device too, which
    // is what stops the phone silently resuming.
    expect(response.headers.getSetCookie()).toEqual([
      "prime_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "prime_web_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    ]);

    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: client.cookie } })).status).toBe(401);
    const replay = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: "{}",
    });
    expect(replay.status).toBe(401);
  });

  /* Sign-out revoked the device but left that device's other sessions alive.

     A second tab, or the same phone reopened, holds its own session started
     from the same credential. Revoking the device stopped new resumes and did
     nothing to those: they kept working — sockets included — for the rest of
     the 12-hour TTL, well after the person had signed out and been told they
     were. */
  it("reaps every session belonging to the device it signs out", async () => {
    const t = await startGateway();
    const paired = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: PAIRING_TOKEN, deviceName: "phone" }),
    });
    expect(paired.status).toBe(200);
    const deviceCookie = paired.headers.getSetCookie()
      .find((value) => value.startsWith("prime_web_device="))!.split(";", 1)[0];
    const first: PairedClient = {
      cookie: paired.headers.get("set-cookie")!.split(";", 1)[0],
      csrfToken: ((await paired.json()) as { csrfToken: string }).csrfToken,
    };

    // A second tab on the same phone: same device credential, its own session.
    const resumed = await fetch(`${t.baseUrl}/api/v1/auth/resume`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: deviceCookie },
    });
    expect(resumed.status).toBe(200);
    const second: PairedClient = {
      cookie: resumed.headers.getSetCookie()
        .find((value) => value.startsWith("prime_web_session="))!.split(";", 1)[0],
      csrfToken: ((await resumed.json()) as { csrfToken: string }).csrfToken,
    };
    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: second.cookie } })).status).toBe(200);

    const socket = openSocket(t, second);
    await once(socket, "open");
    // Listening before the sign-out, not after: the close lands during the
    // request and a listener attached afterwards would wait for a second one.
    const closed = once(socket, "close");

    const signedOut = await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: mutationHeaders(first),
      body: "{}",
    });
    expect(signedOut.status).toBe(200);

    expect((await fetch(`${t.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: second.cookie } })).status).toBe(401);
    // And its socket is told, rather than left delivering until the TTL lapses:
    // outbound events never consult isSessionActive.
    const [code] = await closed;
    expect(code).toBe(1008);
  });

  /* Behind `tailscale serve` every client is 127.0.0.1, so the five-attempts
     "per remote address" budget was one bucket for the whole house. More than
     five phones auto-resuming in the minute after a restart — which is exactly
     what a restart causes — 401ed people who had paired perfectly correctly. */
  it("budgets resumes per proven device rather than per address", async () => {
    const t = await startGateway();
    const cookies: string[] = [];
    // Pairing stays address-keyed on purpose — it is the anonymous, guessable
    // door. Pairing the maximum leaves that budget spent, which is the state a
    // house full of already-paired phones is permanently in.
    for (let index = 0; index < MAX_PAIR_ATTEMPTS_PER_CLIENT; index += 1) {
      const paired = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ token: PAIRING_TOKEN, deviceName: `phone-${index}` }),
      });
      expect(paired.status).toBe(200);
      cookies.push(paired.headers.getSetCookie()
        .find((value) => value.startsWith("prime_web_device="))!.split(";", 1)[0]);
    }

    // Now the restart: every phone auto-resumes, all from one address, all
    // inside one window. Sharing the (already spent) pairing budget refused
    // every one of them.
    for (const cookie of cookies) {
      const resumed = await fetch(`${t.baseUrl}/api/v1/auth/resume`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie },
      });
      expect(resumed.status).toBe(200);
    }
  });

  it("still refuses, and still charges for, a device credential that does not verify", async () => {
    const t = await startGateway();
    for (let index = 0; index < 6; index += 1) {
      const refused = await fetch(`${t.baseUrl}/api/v1/auth/resume`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: `prime_web_device=guess-${index}` },
      });
      expect(refused.status).toBe(401);
    }
    // An unverifiable credential is a guess, and a spent guessing budget locks
    // the address out of pairing too — so minting a fresh id per attempt buys
    // an attacker nothing.
    const paired = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: PAIRING_TOKEN }),
    });
    expect(paired.status).toBe(401);
  });

  it("resumes a paired device after a restart, without the pairing token", async () => {
    const store = join(await mkdtemp(join(tmpdir(), "device-restart-")), "devices.json");

    const first = await startGateway({ config: { deviceStorePath: store } });
    const paired = await fetch(`${first.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: PAIRING_TOKEN, deviceName: "phone" }),
    });
    expect(paired.status).toBe(200);
    const deviceCookie = paired.headers.getSetCookie()
      .find((value) => value.startsWith("prime_web_device="))?.split(";", 1)[0];
    expect(deviceCookie).toBeDefined();

    // A second gateway over the same store is what a restart looks like: the
    // sessions Map is gone, the device file is not.
    const second = await startGateway({ config: { deviceStorePath: store } });
    const resumed = await fetch(`${second.baseUrl}/api/v1/auth/resume`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: deviceCookie! },
    });
    expect(resumed.status).toBe(200);
    const body = await resumed.json() as { paired: boolean; csrfToken: string };
    expect(body.paired).toBe(true);

    const sessionCookie = resumed.headers.getSetCookie()
      .find((value) => value.startsWith("prime_web_session="))!.split(";", 1)[0];
    const bootstrap = await fetch(`${second.baseUrl}/api/v1/bootstrap`, { headers: { Cookie: sessionCookie } });
    expect(bootstrap.status).toBe(200);
  });

  it("refuses to resume without a device credential", async () => {
    const t = await startGateway();
    const response = await fetch(`${t.baseUrl}/api/v1/auth/resume`, { method: "POST", headers: { Origin: ORIGIN } });
    expect(response.status).toBe(401);
  });

  it("refuses to resume a revoked device and clears the dead cookie", async () => {
    const t = await startGateway();
    const paired = await fetch(`${t.baseUrl}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: PAIRING_TOKEN }),
    });
    const cookies = paired.headers.getSetCookie();
    const deviceCookie = cookies.find((value) => value.startsWith("prime_web_device="))!.split(";", 1)[0];
    const sessionCookie = cookies.find((value) => value.startsWith("prime_web_session="))!.split(";", 1)[0];
    const csrfToken = (await paired.json() as { csrfToken: string }).csrfToken;

    // Signing out revokes the device, unlike letting the session expire.
    await fetch(`${t.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: sessionCookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: "{}",
    });

    const resumed = await fetch(`${t.baseUrl}/api/v1/auth/resume`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: deviceCookie },
    });
    expect(resumed.status).toBe(401);
    expect(resumed.headers.getSetCookie()).toContain("prime_web_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  });

  it("refuses to resume from a disallowed origin", async () => {
    const t = await startGateway();
    const response = await fetch(`${t.baseUrl}/api/v1/auth/resume`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test" },
    });
    expect(response.status).toBe(403);
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

  /* The socket-level half of the transcript-never-loads fix.

     A client that attaches to an agent before anything has asked for that
     agent's snapshot used to be told `stream_gone` — the same answer a deleted
     agent gets — because the stream is registered as a side effect of
     projecting a snapshot. The web client treats that as terminal and then
     discards the HTTP snapshot that follows, so the transcript spins forever.
     This is the ordinary order of events right after a restart, when the hub
     holds `catalog` and nothing else. */
  it("attaches to a listed agent that has never had a snapshot requested", async () => {
    const t = await startGateway({ backend: new LazyStreamBackend() });
    const client = await pairClient(t);
    const body = await bootstrap(t, client);
    const agentId = body.catalog.agents[0].id;

    const socket = openSocket(t, client);
    await once(socket, "open");
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));

    // No GET /snapshot first: this is an attach arriving on its own.
    socket.send(JSON.stringify({ type: "attach", version: 1, streamId: `agent:${agentId}`, since: null }));

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const detached = frames.find((frame) => frame.type === "detached");
    expect(detached, `attach was refused: ${JSON.stringify(detached)}`).toBeUndefined();
    expect(frames.some((frame) => frame.type === "snapshot" || frame.type === "event")).toBe(true);

    socket.close();
  });

  it("still reports stream_gone for an agent that does not exist", async () => {
    const t = await startGateway({ backend: new LazyStreamBackend() });
    const client = await pairClient(t);
    await bootstrap(t, client);

    const socket = openSocket(t, client);
    await once(socket, "open");
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));

    socket.send(JSON.stringify({ type: "attach", version: 1, streamId: "agent:no-such-agent", since: null }));

    await vi.waitFor(() => expect(frames.some((frame) => frame.type === "detached")).toBe(true));
    expect(frames.find((frame) => frame.type === "detached")).toMatchObject({ reason: "stream_gone" });

    socket.close();
  });

  /* Two subscribes inside one warmup used to attach twice.

     The warmup promise is shared, so a second subscribe before it resolves
     added a second `.then` to the same promise rather than doing its own work.
     Both continuations then called finishAttach: two hub registrations for one
     socket, every event delivered twice, and — because `subscriptions` only
     remembers the last detach — the first registration unreachable for the
     stream's lifetime. Right after a restart every stream is cold, so this is
     ordinary reconnect traffic, not a narrow race. */
  it("attaches once when a second subscribe arrives during the same warmup", async () => {
    const backend = new GatedLazyStreamBackend();
    const t = await startGateway({ backend });
    const client = await pairClient(t);
    const body = await bootstrap(t, client);
    const agentId = body.catalog.agents[0].id;
    const streamId = `agent:${agentId}`;

    const socket = openSocket(t, client);
    await once(socket, "open");
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));

    backend.hold();
    const attach = JSON.stringify({ type: "attach", version: 1, streamId, since: null });
    socket.send(attach);
    // Both subscribes have to land inside the warmup window for this to be the
    // bug under test, so wait until the server is provably inside it.
    await vi.waitFor(() => expect(backend.snapshotCalls).toBeGreaterThan(0));
    socket.send(attach);
    await settleSocket(socket, frames);
    backend.open();

    await vi.waitFor(() => expect(t.gateway.hub.has(streamId)).toBe(true));
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === "snapshot")).toBe(true));
    // The warmup is shared, so the expensive projection still happens once.
    expect(backend.snapshotCalls).toBe(1);
    expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);

    // The registration count is what actually matters, and it is only visible
    // in delivery: one publish must reach this socket exactly once.
    const snapshot = t.gateway.hub.getSnapshot<AgentSnapshot>(streamId);
    if (!snapshot) throw new Error("The warmed stream has no snapshot");
    t.gateway.hub.publish(streamId, { kind: "agent.replaced", payload: snapshot }, snapshot);
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === "event")).toBe(true));
    expect(frames.filter((frame) => frame.type === "event")).toHaveLength(1);

    socket.close();
  });

  /* The same gap seen from the other side: a detach that lands mid-warmup was
     dropped entirely, so the continuation attached a stream the client had
     already given up on and kept feeding it events. */
  it("does not attach a stream the client detached during its warmup", async () => {
    const backend = new GatedLazyStreamBackend();
    const t = await startGateway({ backend });
    const client = await pairClient(t);
    const body = await bootstrap(t, client);
    const agentId = body.catalog.agents[0].id;
    const streamId = `agent:${agentId}`;

    const socket = openSocket(t, client);
    await once(socket, "open");
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));

    backend.hold();
    socket.send(JSON.stringify({ type: "attach", version: 1, streamId, since: null }));
    await vi.waitFor(() => expect(backend.snapshotCalls).toBeGreaterThan(0));
    socket.send(JSON.stringify({ type: "detach", version: 1, streamId }));
    await settleSocket(socket, frames);
    backend.open();
    await vi.waitFor(() => expect(t.gateway.hub.has(streamId)).toBe(true));

    const snapshot = t.gateway.hub.getSnapshot<AgentSnapshot>(streamId);
    if (!snapshot) throw new Error("The warmed stream has no snapshot");
    t.gateway.hub.publish(streamId, { kind: "agent.replaced", payload: snapshot }, snapshot);

    // A snapshot names its stream directly; an event names it on the envelope.
    const streamOf = (frame: Record<string, unknown>): string | undefined =>
      (frame.streamId as string | undefined)
        ?? (frame.envelope as { streamId?: string } | undefined)?.streamId;

    // A synchronous attach on another stream is the barrier: frames on one
    // socket are ordered, so anything the abandoned warmup sent is here by the
    // time the catalog snapshot lands.
    socket.send(JSON.stringify({ type: "attach", version: 1, streamId: "catalog", since: null }));
    await vi.waitFor(() => expect(frames.some((frame) => streamOf(frame) === "catalog")).toBe(true));
    expect(frames.filter((frame) => streamOf(frame) === streamId)).toHaveLength(0);

    socket.close();
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

  it("stops a live agent and refuses to stop one with no live session", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const agents = (await bootstrap(t, client)).catalog.agents;
    const liveId = agents.find((agent) => agent.capabilities.stop)?.id;
    const savedId = agents.find((agent) => !agent.capabilities.stop && agent.capabilities.resume)?.id;
    if (!liveId || !savedId) throw new Error("Demo catalog has no live and saved pair");

    const stopped = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(liveId)}/stop`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: await agentRevision(t, client, liveId) }),
    });
    expect(stopped.status).toBe(202);
    const after = (await bootstrap(t, client)).catalog.agents.find((agent) => agent.id === liveId);
    expect(after).toMatchObject({ lifecycle: "inactive", capabilities: { resume: true, stop: false } });

    // The capability bit says no, and so must the route.
    const forbidden = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(savedId)}/stop`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: await agentRevision(t, client, savedId) }),
    });
    expect(forbidden.status).toBe(403);

    // The schema is strict: stop carries no payload beyond the two fields.
    const extra = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(savedId)}/stop`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1, force: true }),
    });
    expect(extra.status).toBe(400);
  });

  it("deletes only a stopped session, and only with the matching name", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const agents = (await bootstrap(t, client)).catalog.agents;
    const liveId = agents.find((agent) => agent.capabilities.stop && !agent.capabilities.delete)?.id;
    const target = agents.find((agent) => agent.capabilities.delete);
    if (!liveId || !target) throw new Error("Demo catalog has no live and deletable pair");

    // A live session is refused outright — it has to be stopped first.
    const liveRefused = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(liveId)}/delete`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: await agentRevision(t, client, liveId),
        confirmName: agents.find((agent) => agent.id === liveId)!.name,
      }),
    });
    expect(liveRefused.status).toBe(403);

    // The confirming name is validated server-side, so a browser cannot skip it.
    const wrongName = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(target.id)}/delete`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: await agentRevision(t, client, target.id),
        confirmName: "Not this session",
      }),
    });
    expect(wrongName.status).toBe(403);
    expect((await bootstrap(t, client)).catalog.agents.some((agent) => agent.id === target.id)).toBe(true);

    // Omitting it entirely is a malformed request, not a permitted shortcut.
    const noName = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(target.id)}/delete`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: 1 }),
    });
    expect(noName.status).toBe(400);

    const deleted = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(target.id)}/delete`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: await agentRevision(t, client, target.id),
        confirmName: target.name,
      }),
    });
    expect(deleted.status).toBe(202);
    expect((await bootstrap(t, client)).catalog.agents.some((agent) => agent.id === target.id)).toBe(false);

    const snapshotGone = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(target.id)}/snapshot`, {
      headers: { Cookie: client.cookie },
    });
    expect(snapshotGone.status).toBe(404);
  });

  it("deletes a session whose own name the creation schema would reject", async () => {
    // `uniqueSessionName` appends a disambiguating suffix, which can carry a
    // 200-character name past the bound that governs names entering the
    // system. The confirmation echoes a name already in it, so validating the
    // echo against the stricter rule would leave this session showing a delete
    // control that could never succeed — the offer-but-refuse bug this whole
    // task started from.
    const t = await startGateway();
    const client = await pairClient(t);
    const longName = "x".repeat(200);
    for (let index = 0; index < 2; index += 1) {
      const created = await fetch(`${t.baseUrl}/api/v1/sessions`, {
        method: "POST",
        headers: mutationHeaders(client),
        body: JSON.stringify({ requestId: randomUUID(), cwd: "/", name: longName }),
      });
      expect(created.status).toBe(202);
    }
    const collided = (await bootstrap(t, client)).catalog.agents.find((agent) => agent.name.length > 200);
    if (!collided) throw new Error("Expected a disambiguated name past the creation bound");

    const stopped = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(collided.id)}/stop`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({ requestId: randomUUID(), expectedRevision: await agentRevision(t, client, collided.id) }),
    });
    expect(stopped.status).toBe(202);

    const deletable = (await bootstrap(t, client)).catalog.agents.find((agent) => agent.id === collided.id);
    expect(deletable?.capabilities.delete).toBe(true);
    const deleted = await fetch(`${t.baseUrl}/api/v1/agents/${encodeURIComponent(collided.id)}/delete`, {
      method: "POST",
      headers: mutationHeaders(client),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: await agentRevision(t, client, collided.id),
        confirmName: deletable!.name,
      }),
    });
    expect(deleted.status).toBe(202);
    expect((await bootstrap(t, client)).catalog.agents.some((agent) => agent.id === collided.id)).toBe(false);
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

interface DeviceRow {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

async function listDevices(t: TestGateway, client: PairedClient): Promise<DeviceRow[]> {
  const response = await fetch(`${t.baseUrl}/api/v1/devices`, {
    headers: { Origin: ORIGIN, Cookie: client.cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json() as { devices: DeviceRow[] }).devices;
}

function revokeDevice(t: TestGateway, client: PairedClient, deviceId: string) {
  return fetch(`${t.baseUrl}/api/v1/devices/revoke`, {
    method: "POST",
    headers: mutationHeaders(client),
    body: JSON.stringify({ deviceId }),
  });
}

describe("device management routes", () => {
  it("lists paired devices without handing out any part of a credential", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const devices = await listDevices(t, client);

    expect(devices).toHaveLength(1);
    expect(devices[0]?.current).toBe(true);
    // The point of the store is that it holds "which devices may return", not
    // credentials. A hash is still a piece of one and does not leave.
    expect(JSON.stringify(devices)).not.toContain("secretHash");
    expect(Object.keys(devices[0] ?? {}).sort())
      .toEqual(["createdAt", "current", "id", "lastSeenAt", "name"]);
  });

  it("marks only the requesting device as current", async () => {
    const t = await startGateway();
    const first = await pairClient(t);
    const second = await pairClient(t);

    expect((await listDevices(t, first)).filter((device) => device.current)).toHaveLength(1);
    const asSeenBySecond = await listDevices(t, second);
    expect(asSeenBySecond).toHaveLength(2);
    expect(asSeenBySecond.filter((device) => device.current)).toHaveLength(1);
    expect(asSeenBySecond.find((device) => device.current)?.id)
      .not.toBe((await listDevices(t, first)).find((device) => device.current)?.id);
  });

  it("revokes another device and locks it out immediately", async () => {
    const t = await startGateway();
    const keeper = await pairClient(t);
    const doomed = await pairClient(t);
    const doomedId = (await listDevices(t, doomed)).find((device) => device.current)?.id;
    expect(doomedId).toBeDefined();

    const response = await revokeDevice(t, keeper, doomedId!);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, self: false });

    // Not "gone at the end of its twelve-hour session": the whole reason to
    // revoke is that you no longer have that phone.
    const afterwards = await fetch(`${t.baseUrl}/api/v1/bootstrap`, {
      headers: { Origin: ORIGIN, Cookie: doomed.cookie },
    });
    expect(afterwards.status).toBe(401);
    expect(await listDevices(t, keeper)).toHaveLength(1);
  });

  it("drops the revoked device's push subscriptions with it", async () => {
    const t = await startGateway({ config: { webPush: VAPID } });
    const keeper = await pairClient(t);
    const doomed = await pairClient(t);
    expect((await pushRequest(t, doomed, "subscribe", subscriptionBody())).status).toBe(202);
    expect(t.gateway.pushStore.list()).toHaveLength(1);

    const doomedId = (await listDevices(t, doomed)).find((device) => device.current)?.id;
    expect((await revokeDevice(t, keeper, doomedId!)).status).toBe(200);
    // A wake capability that outlived the credential would keep buzzing a phone
    // that can no longer open what it is being woken for.
    expect(t.gateway.pushStore.list()).toEqual([]);
  });

  it("says so when a device revokes itself, and clears its own cookies", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const ownId = (await listDevices(t, client)).find((device) => device.current)?.id;

    const response = await revokeDevice(t, client, ownId!);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, self: true });
    expect(response.headers.get("set-cookie")).toBeTruthy();
    expect(await fetch(`${t.baseUrl}/api/v1/bootstrap`, {
      headers: { Origin: ORIGIN, Cookie: client.cookie },
    }).then((res) => res.status)).toBe(401);
  });

  it("refuses an unknown device rather than reporting a revoke that did nothing", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    expect((await revokeDevice(t, client, "not-a-device")).status).toBe(404);
    expect(await listDevices(t, client)).toHaveLength(1);
  });

  it("keeps both routes behind authentication, and the revoke behind CSRF", async () => {
    const t = await startGateway();
    const client = await pairClient(t);
    const deviceId = (await listDevices(t, client)).find((device) => device.current)?.id;

    expect((await fetch(`${t.baseUrl}/api/v1/devices`, { headers: { Origin: ORIGIN } })).status).toBe(401);
    const noCsrf = await fetch(`${t.baseUrl}/api/v1/devices/revoke`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: client.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    expect(noCsrf.status).toBe(403);
    expect(await listDevices(t, client)).toHaveLength(1);
  });
});

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

  // A deployment normally has keys now — `index.ts` mints them before the
  // gateway is built — so this is the disk-failure path rather than the common
  // one. Refusing here is still what keeps the browser from handing over a
  // permission this gateway could never act on.
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
