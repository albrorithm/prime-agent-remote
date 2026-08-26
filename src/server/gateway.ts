import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  abortRequestSchema,
  attentionAgentCount,
  attentionResponseSchema,
  cellOutputSchema,
  clientFrameSchema,
  createSessionRequestSchema,
  deleteAgentRequestSchema,
  executeSlashCommandRequestSchema,
  pairRequestSchema,
  PROTOCOL_VERSION,
  pushSubscribeRequestSchema,
  pushUnsubscribeRequestSchema,
  renameAgentRequestSchema,
  stopAgentRequestSchema,
  sendMessageRequestSchema,
  type ProblemDetails,
  type PushAccepted,
  type ServerFrame,
} from "../protocol.js";
import { AuthService, type AuthenticatedSession } from "./auth.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  type AgentBackend,
} from "./backend.js";
import type { GatewayConfig } from "./config.js";
import { EventHub } from "./event-hub.js";
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
import { buildAttentionPushPayload } from "./push-payload.js";
import { PushService } from "./push-service.js";
import { PushSubscriptionStore } from "./push-store.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import {
  enforceOutboundFrameLimits,
  MAX_WEBSOCKET_INBOUND_FRAME_BYTES,
} from "./websocket-frames.js";

export const MUTATION_WINDOW_MS = 60_000;
export const MAX_MUTATIONS_PER_SESSION = 120;
export const MAX_TRACKED_MUTATION_SESSIONS = 4_096;

/**
 * Retries may re-serialize the same body with a different key order; hashing a
 * canonical form keeps a structurally identical retry from reading as a
 * request-ID binding mismatch. Array order stays significant.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry);
}

export interface GatewayDeps {
  backend: AgentBackend;
  hub?: EventHub;
  auth?: AuthService;
  staticRoot?: string;
  mutationLimiter?: SlidingWindowLimiter;
  pushStore?: PushSubscriptionStore;
  pushService?: PushService;
}

export interface Gateway {
  requestListener(req: IncomingMessage, res: ServerResponse): void;
  upgradeListener(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  backend: AgentBackend;
  hub: EventHub;
  auth: AuthService;
  pushStore: PushSubscriptionStore;
  shutdown(): Promise<void>;
}

export async function createGateway(config: GatewayConfig, deps: GatewayDeps): Promise<Gateway> {
  const backend = deps.backend;
  const hub = deps.hub ?? new EventHub();
  await backend.initialize(hub);
  const auth = deps.auth ?? new AuthService(config);
  const staticRoot = deps.staticRoot ?? path.resolve(process.cwd(), "dist");
  const mutationCache = new MutationCache<unknown>(10 * 60_000);
  const mutationLimiter = deps.mutationLimiter
    ?? new SlidingWindowLimiter(MUTATION_WINDOW_MS, MAX_MUTATIONS_PER_SESSION, MAX_TRACKED_MUTATION_SESSIONS);
  const sessionSockets = new Map<string, Set<WebSocket>>();
  const pushStore = deps.pushStore ?? new PushSubscriptionStore(config.webPushStorePath);
  // Never throws: an unreadable store leaves push inert, which must not stop
  // the gateway from serving everything else.
  await pushStore.load();
  const pushService = deps.pushService
    ?? (config.webPush ? new PushService(pushStore, config.webPush) : null);

  // Push fires only on an authoritative attention request — a real
  // AttentionRequest the daemon raised and is waiting on. Never on
  // `needsInput`, which the protocol documents as an advisory guess and never
  // a queue; waking a phone for a guess teaches people to ignore the ones that
  // matter.
  if (pushService) {
    backend.onAttentionAdded?.((attention) => {
      const agents = backend.catalog().agents;
      const payload = buildAttentionPushPayload(
        attention,
        agents.find((agent) => agent.id === attention.agentId)?.name,
        attentionAgentCount(agents),
      );
      void pushService.notify(payload);
    });
  }

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

  // GET routes deliberately skip the Origin check: the session cookie is
  // SameSite=Strict, so a cross-site page can never attach it, and reads leak
  // nothing without it. Mutations and the WebSocket upgrade validate Origin
  // (and CSRF) explicitly. Keep that asymmetry in both directions.
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
    const decision = mutationLimiter.allow(session.id);
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
      problem(res, 429, "Too many mutation requests");
      return false;
    }
    return true;
  }

  function mutationBinding(scope: string, value: unknown): string {
    const semanticValue = value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "requestId" && key !== "expectedRevision"))
      : value;
    return `${scope}:${createHash("sha256").update(stableStringify(semanticValue)).digest("base64url")}`;
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
        // So Settings can say "the gateway has no keys" instead of offering a
        // switch that silently does nothing. The VAPID public key is public by
        // design — it is what the browser subscribes with.
        push: { enabled: Boolean(config.webPush), publicKey: config.webPush?.publicKey ?? null },
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

    const cellMatch = pathname.match(/^\/api\/v1\/cells\/([^/]+)$/);
    if (req.method === "GET" && cellMatch) {
      const cellId = decodeSegment(cellMatch[1]);
      const cached = cellId ? backend.cellOutput(cellId) : null;
      const cell = cached ? cellOutputSchema.safeParse(cached).data ?? null : null;
      if (!cell) {
        problem(res, 404, "Cell output not found");
      } else {
        securityHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "private, no-store");
        res.end(JSON.stringify(cell));
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

    // Above the mutation gate, and so above the rate limiter: revoking a
    // session must never be the one request a session cannot make. It still
    // validates Origin and CSRF, which is what actually guards it.
    if (req.method === "POST" && pathname === "/api/v1/auth/logout") {
      if (!auth.validateMutation(req, session)) {
        problem(res, 403, "Origin or CSRF validation failed");
        return true;
      }
      // Deliberately not request-ID deduplicated: the cache is keyed by session
      // id, and this call destroys that session, so a replay 401s before it
      // could ever reach a cached entry.
      await readJson(req);
      // Sign-out revokes push; a TTL lapse deliberately does not. Revocation
      // is attempted first so the wake capability dies with the session, but a
      // failure to persist must not make the session unsignoutable: the record
      // is already out of this process's memory either way.
      await pushStore.removeSession(session.id).catch((error: unknown) => {
        console.error("Could not persist push revocation on sign-out", error);
      });
      const sockets = [...(sessionSockets.get(session.id) ?? [])];
      auth.signOut(res, session);
      for (const ws of sockets) closeWebSocket(ws, 1008, "Signed out");
      json(res, 200, { signedOut: true });
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

    const renameMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/rename$/);
    if (req.method === "POST" && renameMatch) {
      const agentId = decodeSegment(renameMatch[1]);
      const parsed = renameAgentRequestSchema.safeParse(await readJson(req));
      if (!agentId || !parsed.success) { problem(res, 400, "Invalid rename request"); return true; }
      const result = await deduplicated(
        session,
        parsed.data.requestId,
        mutationBinding(`rename:${agentId}`, parsed.data),
        () => backend.rename({ agentId, ...parsed.data }),
      );
      json(res, 202, result);
      return true;
    }

    const stopMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      const agentId = decodeSegment(stopMatch[1]);
      const parsed = stopAgentRequestSchema.safeParse(await readJson(req));
      if (!agentId || !parsed.success) { problem(res, 400, "Invalid stop request"); return true; }
      const result = await deduplicated(
        session,
        parsed.data.requestId,
        mutationBinding(`stop:${agentId}`, parsed.data),
        () => backend.stop({ agentId, ...parsed.data }),
      );
      json(res, 202, result);
      return true;
    }

    const deleteMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/delete$/);
    if (req.method === "POST" && deleteMatch) {
      const agentId = decodeSegment(deleteMatch[1]);
      const parsed = deleteAgentRequestSchema.safeParse(await readJson(req));
      if (!agentId || !parsed.success) { problem(res, 400, "Invalid delete request"); return true; }
      const result = await deduplicated(
        session,
        parsed.data.requestId,
        mutationBinding(`delete:${agentId}`, parsed.data),
        () => backend.delete({ agentId, ...parsed.data }),
      );
      json(res, 202, result);
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/v1/push/subscribe" || pathname === "/api/v1/push/unsubscribe")) {
      const subscribing = pathname.endsWith("/subscribe");
      const schema = subscribing ? pushSubscribeRequestSchema : pushUnsubscribeRequestSchema;
      const parsed = schema.safeParse(await readJson(req));
      if (!parsed.success) { problem(res, 400, "Invalid push subscription request"); return true; }
      // Storing a subscription this gateway can never send to would leave the
      // browser holding a permission it gave for nothing.
      if (subscribing && !config.webPush) {
        problem(res, 503, "Push notifications are not configured", "The gateway has no VAPID keys.");
        return true;
      }
      const request = parsed.data;
      const result = await deduplicated<PushAccepted>(
        session,
        request.requestId,
        mutationBinding(subscribing ? "push-subscribe" : "push-unsubscribe", request),
        async () => {
          if ("subscription" in request) {
            await pushStore.upsert({
              endpoint: request.subscription.endpoint,
              p256dh: request.subscription.keys.p256dh,
              auth: request.subscription.keys.auth,
              sessionId: session.id,
              createdAt: new Date().toISOString(),
            });
          } else {
            // Unsubscribing an endpoint this gateway never had is the goal
            // state, so it succeeds rather than 404s.
            await pushStore.removeEndpoint(request.endpoint);
          }
          return { accepted: true, requestId: request.requestId };
        },
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
    if (!filePath.startsWith(`${staticRoot}${path.sep}`)) {
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

  async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  }

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

    const bound = sessionSockets.get(session.id) ?? new Set<WebSocket>();
    bound.add(ws);
    sessionSockets.set(session.id, bound);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      for (const detach of subscriptions.values()) detach();
      subscriptions.clear();
      bound.delete(ws);
      if (bound.size === 0) sessionSockets.delete(session.id);
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

  function upgradeListener(req: IncomingMessage, socket: Duplex, head: Buffer): void {
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
  }

  async function shutdown(): Promise<void> {
    hub.close();
    await backend.close();
    for (const client of wss.clients) client.close(1001, "Server shutdown");
  }

  return { requestListener, upgradeListener, backend, hub, auth, pushStore, shutdown };
}
