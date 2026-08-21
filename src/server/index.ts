import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  abortRequestSchema,
  attentionResponseSchema,
  clientFrameSchema,
  createSessionRequestSchema,
  pairRequestSchema,
  PROTOCOL_VERSION,
  sendMessageRequestSchema,
  type MutationAccepted,
  type ProblemDetails,
  type ServerFrame,
} from "../protocol.js";
import { AuthService, type AuthenticatedSession } from "./auth.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  type AgentBackend,
} from "./backend.js";
import { loadConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { EventHub } from "./event-hub.js";
import { PrimeBackend } from "./prime-backend.js";
import { MutationCache } from "./mutation-cache.js";

const config = loadConfig();
const backend: AgentBackend = config.backend === "prime"
  ? new PrimeBackend(config.primeModule, config.daemonSocket)
  : new DemoBackend();
const hub = new EventHub();
await backend.initialize(hub);
const auth = new AuthService(config);
const staticRoot = path.resolve(process.cwd(), "dist");
const mutationCache = new MutationCache<unknown>(10 * 60_000);
const mutationTimes = new Map<string, number[]>();

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (config.secureCookie) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function problem(res: ServerResponse, status: number, title: string, detail?: string): void {
  const value: ProblemDetails = { type: "about:blank", title, status, ...(detail ? { detail } : {}) };
  json(res, status, value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authenticated(req: IncomingMessage, res: ServerResponse): AuthenticatedSession | null {
  const session = auth.authenticate(req);
  if (!session) problem(res, 401, "Authentication required");
  return session;
}

function allowMutation(req: IncomingMessage, res: ServerResponse, session: AuthenticatedSession): boolean {
  if (!auth.validateMutation(req, session)) {
    problem(res, 403, "Origin or CSRF validation failed");
    return false;
  }
  const now = Date.now();
  const times = (mutationTimes.get(session.id) ?? []).filter((time) => now - time < 60_000);
  if (times.length >= 120) {
    problem(res, 429, "Too many mutation requests");
    return false;
  }
  times.push(now);
  mutationTimes.set(session.id, times);
  return true;
}

async function deduplicated<T>(
  session: AuthenticatedSession,
  requestId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return mutationCache.run(session.id, requestId, operation) as Promise<T>;
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") && !decoded.includes("\\") ? decoded : null;
  } catch {
    return null;
  }
}

async function api(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  if (req.method === "POST" && pathname === "/api/v1/auth/pair") {
    if (!auth.isAllowedOrigin(req)) { problem(res, 403, "Origin validation failed"); return true; }
    const parsed = pairRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) { problem(res, 400, "Invalid pairing request"); return true; }
    const session = auth.pair(req, res, parsed.data.token);
    if (!session) { problem(res, 401, "Invalid pairing token"); return true; }
    json(res, 200, { paired: true, csrfToken: session.csrfToken });
    return true;
  }

  const session = authenticated(req, res);
  if (!session) return true;

  if (req.method === "GET" && pathname === "/api/v1/bootstrap") {
    json(res, 200, {
      protocolVersion: PROTOCOL_VERSION,
      csrfToken: session.csrfToken,
      backend: backend.kind,
      catalog: backend.catalog(),
    });
    return true;
  }

  const snapshotMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/snapshot$/);
  if (req.method === "GET" && snapshotMatch) {
    const agentId = decodeSegment(snapshotMatch[1]);
    const snapshot = agentId ? await backend.agentSnapshot(agentId) : null;
    if (!snapshot) problem(res, 404, "Agent not found");
    else json(res, 200, snapshot);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/v1/directories") {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const requested = url.searchParams.get("path") ?? undefined;
    try {
      json(res, 200, await backend.listDirectories(requested));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      problem(res, 400, "Directory path must be absolute");
    }
    return true;
  }

  if (!allowMutation(req, res, session)) return true;

  if (req.method === "POST" && pathname === "/api/v1/sessions") {
    const parsed = createSessionRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) { problem(res, 400, "Invalid session request"); return true; }
    const result = await deduplicated(session, parsed.data.requestId, () => backend.createSession(parsed.data));
    json(res, 202, result);
    return true;
  }

  const messageMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const agentId = decodeSegment(messageMatch[1]);
    const parsed = sendMessageRequestSchema.safeParse(await readJson(req));
    if (!agentId || !parsed.success) { problem(res, 400, "Invalid message request"); return true; }
    const result = await deduplicated(session, parsed.data.requestId, () =>
      backend.sendMessage({ agentId, ...parsed.data }),
    );
    json(res, 202, result);
    return true;
  }

  const abortMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/abort$/);
  if (req.method === "POST" && abortMatch) {
    const agentId = decodeSegment(abortMatch[1]);
    const parsed = abortRequestSchema.safeParse(await readJson(req));
    if (!agentId || !parsed.success) { problem(res, 400, "Invalid abort request"); return true; }
    const result = await deduplicated(session, parsed.data.requestId, () => backend.abort({ agentId, ...parsed.data }));
    json(res, 202, result);
    return true;
  }

  const attentionMatch = pathname.match(/^\/api\/v1\/attention\/([^/]+)\/respond$/);
  if (req.method === "POST" && attentionMatch) {
    const attentionId = decodeSegment(attentionMatch[1]);
    const parsed = attentionResponseSchema.safeParse(await readJson(req));
    if (!attentionId || !parsed.success) { problem(res, 400, "Invalid attention response"); return true; }
    const result = await deduplicated(session, parsed.data.requestId, () =>
      backend.resolveAttention({ attentionId, ...parsed.data }),
    );
    json(res, 202, result);
    return true;
  }

  problem(res, 404, "API route not found");
  return true;
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let filePath = path.resolve(staticRoot, requested);
  if (!filePath.startsWith(`${staticRoot}${path.sep}`) && filePath !== path.join(staticRoot, "index.html")) {
    return problem(res, 404, "Not found");
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error("not_file");
  } catch {
    filePath = path.join(staticRoot, "index.html");
  }
  try {
    const body = await readFile(filePath);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeTypes[path.extname(filePath)] ?? "application/octet-stream");
    const basename = path.basename(filePath);
    res.setHeader("Cache-Control", basename === "index.html" || basename === "sw.js" || basename === "manifest.webmanifest"
      ? "no-cache"
      : "public, max-age=3600");
    res.end(body);
  } catch {
    problem(res, 404, "Web build not found", "Run npm run build before npm start.");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    if (await api(req, res, url.pathname)) return;
    await serveStatic(res, url.pathname);
  } catch (error) {
    if (error instanceof SyntaxError) return problem(res, 400, "Invalid JSON");
    if (error instanceof Error && error.message === "request_too_large") return problem(res, 413, "Request too large");
    if (error instanceof BackendNotFoundError) return problem(res, 404, error.message);
    if (error instanceof BackendConflictError) return problem(res, 409, "State conflict", error.message);
    if (error instanceof BackendCapabilityError) return problem(res, 403, "Action is not allowed", error.message);
    console.error("Request failed", error);
    problem(res, 500, "Internal server error");
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  if (pathname !== "/ws/v1/events" || !auth.isAllowedOrigin(req) || !auth.authenticate(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket) => {
  const subscriptions = new Map<string, () => void>();
  const send = (frame: ServerFrame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.close(1013, "Client is too slow");
      return;
    }
    ws.send(JSON.stringify(frame));
  };
  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      ws.close(1007, "Invalid JSON");
      return;
    }
    const result = clientFrameSchema.safeParse(parsed);
    if (!result.success) {
      ws.close(1008, "Invalid protocol frame");
      return;
    }
    const frame = result.data;
    if (frame.type === "ping") return send({ type: "pong", version: PROTOCOL_VERSION });
    if (frame.type === "detach") {
      subscriptions.get(frame.streamId)?.();
      subscriptions.delete(frame.streamId);
      return;
    }
    subscriptions.get(frame.streamId)?.();
    const attached = hub.attach(frame.streamId, frame.since, send);
    if (!attached) {
      send({ type: "detached", version: PROTOCOL_VERSION, streamId: frame.streamId, reason: "stream_gone" });
      return;
    }
    subscriptions.set(frame.streamId, attached.detach);
    send(attached.initial);
  });
  ws.on("close", () => {
    for (const detach of subscriptions.values()) detach();
    subscriptions.clear();
  });
});

server.listen(config.port, config.host, () => {
  console.log(`Prime Agent Web gateway listening on http://${config.host}:${config.port}`);
  console.log(`Backend: ${backend.kind}`);
  if (config.generatedPairingToken) console.log(`Setup pairing token: ${config.pairingToken}`);
});

async function shutdown(): Promise<void> {
  hub.close();
  await backend.close();
  for (const client of wss.clients) client.close(1001, "Server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
