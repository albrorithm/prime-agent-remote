import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

interface RunningGateway {
  child: ChildProcess;
  origin: string;
  port: number;
  stderr: () => string;
}

const running = new Set<RunningGateway>();

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function startGateway(extraEnv: Record<string, string> = {}): Promise<RunningGateway> {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/server/index.ts")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PRIME_WEB_PORT: String(port),
      PRIME_WEB_HOST: "127.0.0.1",
      PRIME_WEB_ALLOWED_ORIGINS: origin,
      PRIME_WEB_PAIRING_TOKEN: "transport-test-token",
      PRIME_WEB_BACKEND: "demo",
      PRIME_WEB_SECURE_COOKIE: "false",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const gateway = { child, origin, port, stderr: () => stderr };
  running.add(gateway);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${stderr}`)), 8_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited during startup (${code}): ${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("gateway listening")) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    });
  });
  return gateway;
}

async function stopGateway(gateway: RunningGateway): Promise<void> {
  running.delete(gateway);
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      gateway.child.kill("SIGKILL");
      reject(new Error("Gateway shutdown timed out"));
    }, 4_000);
    gateway.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    gateway.child.kill("SIGTERM");
  });
}

afterEach(async () => {
  await Promise.all([...running].map((gateway) => stopGateway(gateway)));
});

async function pair(gateway: RunningGateway): Promise<{ cookie: string; csrfToken: string }> {
  const response = await fetch(`${gateway.origin}/api/v1/auth/pair`, {
    method: "POST",
    headers: { Origin: gateway.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "transport-test-token" }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Pairing did not return a cookie");
  return { cookie, csrfToken: body.csrfToken };
}

async function openWebSocket(gateway: RunningGateway, cookie: string): Promise<WebSocket> {
  const ws = new WebSocket(`${gateway.origin.replace("http:", "ws:")}/ws/v1/events`, {
    origin: gateway.origin,
    headers: { Cookie: cookie },
  });
  await once(ws, "open");
  return ws;
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket did not close")), 4_000);
    ws.once("error", reject);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function sendMalformedUpgrade(gateway: RunningGateway): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(gateway.port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Malformed upgrade did not finish"));
    }, 3_000);
    const finish = () => { clearTimeout(timer); resolve(); };
    socket.once("connect", () => {
      socket.write([
        "GET //[invalid HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGVzdC10ZXN0LXRlc3Q=",
        "",
        "",
      ].join("\r\n"));
    });
    socket.once("data", () => { socket.destroy(); finish(); });
    socket.once("error", finish);
    socket.once("close", finish);
  });
}

describe("gateway WebSocket transport", () => {
  it("survives malformed unauthenticated upgrades and malformed per-socket frames", async () => {
    const gateway = await startGateway();
    await sendMalformedUpgrade(gateway);
    expect((await fetch(`${gateway.origin}/api/v1/bootstrap`)).status).toBe(401);

    const { cookie } = await pair(gateway);
    const invalidJson = await openWebSocket(gateway, cookie);
    const invalidJsonClose = closed(invalidJson);
    invalidJson.send("{");
    await expect(invalidJsonClose).resolves.toMatchObject({ code: 1007 });

    const binary = await openWebSocket(gateway, cookie);
    const binaryClose = closed(binary);
    binary.send(Buffer.from(JSON.stringify({ type: "ping", version: 1 })));
    await expect(binaryClose).resolves.toMatchObject({ code: 1003 });

    const malformedWire = await openWebSocket(gateway, cookie);
    const malformedWireClose = closed(malformedWire);
    const underlying = (malformedWire as unknown as { _socket: { write(bytes: Buffer): void } })._socket;
    // Client frames must be masked. This deliberately reaches the receiver's protocol-error path.
    underlying.write(Buffer.from([0x81, 0x01, 0x7b]));
    await expect(malformedWireClose).resolves.toMatchObject({ code: 1002 });

    expect((await fetch(`${gateway.origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(200);
    await stopGateway(gateway);
  });

  it("closes a live socket when its authenticated session expires", async () => {
    const gateway = await startGateway({ PRIME_WEB_SESSION_TTL_MS: "750" });
    const { cookie } = await pair(gateway);
    const ws = await openWebSocket(gateway, cookie);
    await expect(closed(ws)).resolves.toMatchObject({ code: 1008, reason: "Session expired" });
    expect((await fetch(`${gateway.origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(401);
    await stopGateway(gateway);
  });

  it("delivers a protocol-valid serialized snapshot above the former 1 MiB ceiling", async () => {
    const gateway = await startGateway();
    const { cookie, csrfToken } = await pair(gateway);
    const bootstrap = await (await fetch(`${gateway.origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } })).json() as {
      catalog: { agents: Array<{ id: string; capabilities: { send: boolean } }> };
    };
    const agentId = bootstrap.catalog.agents.find((agent) => agent.capabilities.send)?.id;
    if (!agentId) throw new Error("No send-capable demo agent");
    const snapshot = await (await fetch(`${gateway.origin}/api/v1/agents/${encodeURIComponent(agentId)}/snapshot`, {
      headers: { Cookie: cookie },
    })).json() as { revision: number };
    let revision = snapshot.revision;
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${gateway.origin}/api/v1/agents/${encodeURIComponent(agentId)}/messages`, {
        method: "POST",
        headers: {
          Origin: gateway.origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          expectedRevision: revision,
          text: String(index).padStart(2, "0") + "x".repeat(99_998),
        }),
      });
      expect(response.status).toBe(202);
      revision = ((await response.json()) as { revision: number }).revision;
    }

    const ws = await openWebSocket(gateway, cookie);
    const received = new Promise<{ bytes: number; type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Large snapshot was not delivered")), 5_000);
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`Socket closed before snapshot delivery (${code})`)));
      ws.once("message", (raw) => {
        clearTimeout(timer);
        const serialized = raw.toString();
        resolve({ bytes: Buffer.byteLength(serialized), type: (JSON.parse(serialized) as { type: string }).type });
      });
    });
    ws.send(JSON.stringify({ type: "attach", version: 1, streamId: `agent:${agentId}`, since: null }));
    const delivered = await received;
    expect(delivered.type).toBe("snapshot");
    expect(delivered.bytes).toBeGreaterThan(1.9 * 1024 * 1024);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const gracefulClose = closed(ws);
    ws.close(1000);
    await expect(gracefulClose).resolves.toMatchObject({ code: 1000 });
    await stopGateway(gateway);
  }, 15_000);
});

describe("gateway static responses", () => {
  it("uses PNG MIME, 404s missing assets, and restricts methods", async () => {
    const filename = `transport-test-${randomUUID()}.png`;
    const assetPath = join(process.cwd(), "dist", filename);
    await mkdir(join(process.cwd(), "dist"), { recursive: true });
    await writeFile(assetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const gateway = await startGateway();
      const image = await fetch(`${gateway.origin}/${filename}`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");

      expect((await fetch(`${gateway.origin}/${filename}.missing`)).status).toBe(404);
      const disallowed = await fetch(`${gateway.origin}/${filename}`, { method: "POST" });
      expect(disallowed.status).toBe(405);
      expect(disallowed.headers.get("allow")).toBe("GET, HEAD");
      await stopGateway(gateway);
    } finally {
      await rm(assetPath, { force: true });
    }
  });
});
