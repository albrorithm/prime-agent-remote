import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  abortRequestSchema,
  attentionResponseSchema,
  clientFrameSchema,
  createSessionRequestSchema,
  executeSlashCommandRequestSchema,
  pairRequestSchema,
  PROTOCOL_VERSION,
  sendMessageRequestSchema,
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
import {
  MutationCache,
  MutationCacheCapacityError,
  MutationCacheMismatchError,
} from "./mutation-cache.js";
import {
  ImageAttachmentValidationError,
  MAX_IMAGE_REQUEST_BASE64_CHARS,
  validateImageAttachments,
} from "./image-attachments.js";
import {
  enforceOutboundFrameLimits,
  MAX_WEBSOCKET_INBOUND_FRAME_BYTES,
} from "./websocket-frames.js";

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
const MUTATION_WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_SESSION = 120;
const MAX_TRACKED_MUTATION_SESSIONS = 4_096;
let lastMutationPruneAt = Number.NEGATIVE_INFINITY;

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'");
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

async function readJson(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("request_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
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

function pruneMutationTimes(now: number, force = false): void {
  if (!force && now - lastMutationPruneAt < MUTATION_WINDOW_MS) return;
  lastMutationPruneAt = now;
  for (const [sessionId, times] of mutationTimes) {
    const recent = times.filter((time) => now - time < MUTATION_WINDOW_MS);
    if (recent.length === 0) mutationTimes.delete(sessionId);
    else if (recent.length !== times.length) mutationTimes.set(sessionId, recent);
  }
}

function allowMutation(req: IncomingMessage, res: ServerResponse, session: AuthenticatedSession): boolean {
  if (!auth.validateMutation(req, session)) {
    problem(res, 403, "Origin or CSRF validation failed");
    return false;
  }
  const now = Date.now();
  pruneMutationTimes(now, mutationTimes.size >= MAX_TRACKED_MUTATION_SESSIONS);
  const times = (mutationTimes.get(session.id) ?? []).filter((time) => now - time < MUTATION_WINDOW_MS);
  if (times.length >= MAX_MUTATIONS_PER_SESSION
    || (!mutationTimes.has(session.id) && mutationTimes.size >= MAX_TRACKED_MUTATION_SESSIONS)) {
    problem(res, 429, "Too many mutation requests");
    return false;
  }
  times.push(now);
  mutationTimes.set(session.id, times);
  return true;
}

function mutationBinding(scope: string, value: unknown): string {
  const semanticValue = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "requestId" && key !== "expectedRevision"))
    : value;
  return `${scope}:${createHash("sha256").update(JSON.stringify(semanticValue)).digest("base64url")}`;
}

async function deduplicated<T>(
  session: AuthenticatedSession,
  requestId: string,
  binding: string,
  operation: () => Promise<T>,
): Promise<T> {
  return mutationCache.run(session.id, requestId, binding, operation) as Promise<T>;
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

  const attachmentMatch = pathname.match(/^\/api\/v1\/attachments\/([^/]+)$/);
  if (req.method === "GET" && attachmentMatch) {
    const attachmentId = decodeSegment(attachmentMatch[1]);
    const attachment = attachmentId ? backend.attachment(attachmentId) : null;
    if (!attachment) {
      problem(res, 404, "Attachment not found");
    } else {
      securityHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", attachment.mimeType);
      res.setHeader("Content-Length", attachment.bytes.byteLength);
      res.setHeader("Cache-Control", "private, no-store");
      res.end(attachment.bytes);
    }
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

  const commandMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/commands$/);
  if (req.method === "GET" && commandMatch) {
    const agentId = decodeSegment(commandMatch[1]);
    const catalog = agentId ? await backend.slashCommandCatalog(agentId) : null;
    if (!catalog) problem(res, 404, "Agent not found");
    else json(res, 200, catalog);
    return true;
  }

  if (!allowMutation(req, res, session)) return true;

  if (req.method === "POST" && pathname === "/api/v1/sessions") {
    const parsed = createSessionRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) { problem(res, 400, "Invalid session request"); return true; }
    const result = await deduplicated(
      session,
      parsed.data.requestId,
      mutationBinding("create-session", parsed.data),
      () => backend.createSession(parsed.data),
    );
    json(res, 202, result);
    return true;
  }

  const messageMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const agentId = decodeSegment(messageMatch[1]);
    const messageBodyLimit = MAX_IMAGE_REQUEST_BASE64_CHARS + 1024 * 1024;
    const parsed = sendMessageRequestSchema.safeParse(await readJson(req, messageBodyLimit));
    if (!agentId || !parsed.success) { problem(res, 400, "Invalid message request"); return true; }
    let images;
    try {
      images = validateImageAttachments(parsed.data.images);
    } catch (error) {
      if (!(error instanceof ImageAttachmentValidationError)) throw error;
      problem(res, 400, "Invalid image attachment", error.message);
      return true;
    }
    const result = await deduplicated(
      session,
      parsed.data.requestId,
      mutationBinding(`message:${agentId}`, parsed.data),
      () => backend.sendMessage({ agentId, ...parsed.data, images }),
    );
    json(res, 202, result);
    return true;
  }

  if (req.method === "POST" && commandMatch) {
    const agentId = decodeSegment(commandMatch[1]);
    const parsed = executeSlashCommandRequestSchema.safeParse(await readJson(req));
    if (!agentId || !parsed.success) { problem(res, 400, "Invalid slash command request"); return true; }
    const result = await deduplicated(
      session,
      parsed.data.requestId,
      mutationBinding(`command:${agentId}`, parsed.data),
      () => backend.executeSlashCommand({ agentId, ...parsed.data }),
    );
    json(res, 202, result);
    return true;
  }

  const abortMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/abort$/);
  if (req.method === "POST" && abortMatch) {
    const agentId = decodeSegment(abortMatch[1]);
    const parsed = abortRequestSchema.safeParse(await readJson(req));
    if (!agentId || !parsed.success) { problem(res, 400, "Invalid abort request"); return true; }
    const result = await deduplicated(
      session,
      parsed.data.requestId,
      mutationBinding(`abort:${agentId}`, parsed.data),
      () => backend.abort({ agentId, ...parsed.data }),
    );
    json(res, 202, result);
    return true;
  }

  const attentionMatch = pathname.match(/^\/api\/v1\/attention\/([^/]+)\/respond$/);
  if (req.method === "POST" && attentionMatch) {
    const attentionId = decodeSegment(attentionMatch[1]);
    const parsed = attentionResponseSchema.safeParse(await readJson(req));
    if (!attentionId || !parsed.success) { problem(res, 400, "Invalid attention response"); return true; }
    const result = await deduplicated(
      session,
      parsed.data.requestId,
      mutationBinding(`attention:${attentionId}`, parsed.data),
      () => backend.resolveAttention({ attentionId, ...parsed.data }),
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
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return problem(res, 405, "Method not allowed");
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(staticRoot, requested);
  if (!filePath.startsWith(`${staticRoot}${path.sep}`) && filePath !== path.join(staticRoot, "index.html")) {
    return problem(res, 404, "Not found");
  }
  try {
    if (!(await stat(filePath)).isFile()) return problem(res, 404, "Not found");
    const body = await readFile(filePath);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", body.byteLength);
    const basename = path.basename(filePath);
    res.setHeader("Cache-Control", basename === "index.html" || basename === "sw.js" || basename === "manifest.webmanifest"
      ? "no-cache"
      : "public, max-age=3600");
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    if (requested !== "index.html") return problem(res, 404, "Not found");
    problem(res, 404, "Web build not found", "Run npm run build before npm start.");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    if (await api(req, res, url.pathname)) return;
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    if (error instanceof SyntaxError) return problem(res, 400, "Invalid JSON");
    if (error instanceof Error && error.message === "request_too_large") return problem(res, 413, "Request too large");
    if (error instanceof BackendNotFoundError) return problem(res, 404, error.message);
    if (error instanceof BackendConflictError || error instanceof MutationCacheMismatchError) {
      return problem(res, 409, "State conflict", error.message);
    }
    if (error instanceof MutationCacheCapacityError) {
      return problem(res, 429, "Too many mutations are pending");
    }
    if (error instanceof BackendCapabilityError) return problem(res, 403, "Action is not allowed", error.message);
    console.error("Request failed", error);
    problem(res, 500, "Internal server error");
  }
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WEBSOCKET_INBOUND_FRAME_BYTES,
  perMessageDeflate: false,
});

function closeWebSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function rejectWebSocketUpgrade(socket: Duplex, status: 400 | 401): void {
  if (socket.destroyed || !socket.writable) return;
  const label = status === 400 ? "Bad Request" : "Unauthorized";
  try {
    socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

function configureWebSocket(ws: WebSocket, session: AuthenticatedSession): void {
  const subscriptions = new Map<string, () => void>();
  let expiryTimer: NodeJS.Timeout | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (expiryTimer) clearTimeout(expiryTimer);
    for (const detach of subscriptions.values()) detach();
    subscriptions.clear();
  };

  const send = (frame: ServerFrame) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch {
      closeWebSocket(ws, 1011, "Frame serialization failed");
      return;
    }
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (!enforceOutboundFrameLimits(
      serializedBytes,
      ws.bufferedAmount,
      (code, reason) => closeWebSocket(ws, code, reason),
    )) return;
    try {
      ws.send(serialized, (error) => {
        if (error && ws.readyState !== WebSocket.CLOSED) ws.terminate();
      });
    } catch {
      ws.terminate();
    }
  };

  ws.on("error", cleanup);
  ws.on("close", cleanup);
  ws.on("message", (raw, isBinary) => {
    try {
      if (!auth.isSessionActive(session)) {
        closeWebSocket(ws, 1008, "Session expired");
        return;
      }
      if (isBinary) {
        closeWebSocket(ws, 1003, "Binary frames are not supported");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        closeWebSocket(ws, 1007, "Invalid JSON");
        return;
      }
      const result = clientFrameSchema.safeParse(parsed);
      if (!result.success) {
        closeWebSocket(ws, 1008, "Invalid protocol frame");
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
    } catch {
      closeWebSocket(ws, 1011, "WebSocket processing failed");
    }
  });

  expiryTimer = setTimeout(() => {
    cleanup();
    closeWebSocket(ws, 1008, "Session expired");
  }, Math.max(0, session.expiresAt - Date.now()));
  expiryTimer.unref();
}

wss.on("error", (error) => {
  console.error("WebSocket server error", error);
});

server.on("upgrade", (req, socket, head) => {
  // Upgrade failures otherwise have no ServerResponse error boundary.
  socket.on("error", () => {});
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  } catch {
    rejectWebSocketUpgrade(socket, 400);
    return;
  }
  const session = pathname === "/ws/v1/events" && auth.isAllowedOrigin(req)
    ? auth.authenticate(req)
    : null;
  if (!session) {
    rejectWebSocketUpgrade(socket, 401);
    return;
  }
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        configureWebSocket(ws, session);
      } catch {
        ws.terminate();
      }
    });
  } catch {
    rejectWebSocketUpgrade(socket, 400);
  }
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
