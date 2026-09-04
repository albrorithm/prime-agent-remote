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
  revokeDeviceRequestSchema,
  type DeviceListSnapshot,
  renameAgentRequestSchema,
  stopAgentRequestSchema,
  sendMessageRequestSchema,
  type ProblemDetails,
  type PushAccepted,
  type ServerFrame,
  type StreamCursor,
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
import { buildAttentionPushPayload, buildTurnEndPushPayload } from "./push-payload.js";
import { PushService } from "./push-service.js";
import { TurnEndNotifier } from "./turn-end-notifier.js";
import { DeviceStore } from "./device-store.js";
import { PushSubscriptionStore } from "./push-store.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import {
  enforceOutboundFrameLimits,
  MAX_WEBSOCKET_INBOUND_FRAME_BYTES,
} from "./websocket-frames.js";

export const MUTATION_WINDOW_MS = 60_000;
/* How often the turn-end notifier reads the catalog. It only has to be well
   inside the quiet period it is measuring, not precise. */
const TURN_END_POLL_MS = 5_000;
/* Attention requests end by being answered, by timing out, or by being
   cancelled, and only the first passes through this file. Bounded so the other
   two cannot accumulate. */
const MAX_TRACKED_ATTENTION_OWNERS = 256;
export const MAX_MUTATIONS_PER_SESSION = 120;
export const MAX_TRACKED_MUTATION_SESSIONS = 4_096;
/** How long a shutdown waits for sockets to answer its close before cutting them. */
export const SHUTDOWN_GRACE_MS = 500;

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
  deviceStore?: DeviceStore;
  pushService?: PushService;
}

export interface Gateway {
  requestListener(req: IncomingMessage, res: ServerResponse): void;
  upgradeListener(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  backend: AgentBackend;
  hub: EventHub;
  auth: AuthService;
  pushStore: PushSubscriptionStore;
  /** Null unless push is configured. Exposed, like `pushStore`, so a test can see whether a route armed a turn. */
  turnEnd: TurnEndNotifier | null;
  shutdown(): Promise<void>;
}

export async function createGateway(config: GatewayConfig, deps: GatewayDeps): Promise<Gateway> {
  const backend = deps.backend;
  const hub = deps.hub ?? new EventHub();
  await backend.initialize(hub);
  const deviceStore = deps.deviceStore ?? new DeviceStore(config.deviceStorePath);
  // Never throws: a corrupt store costs one re-pairing, which must not stop
  // the gateway from serving everything else.
  await deviceStore.load();
  // One instance, shared. Two would keep separate in-memory lists over the
  // same file, so a credential issued through one would not verify in the other.
  const auth = deps.auth ?? new AuthService(config, deviceStore);
  const staticRoot = deps.staticRoot ?? path.resolve(process.cwd(), "dist");
  const AGENT_STREAM_PREFIX = "agent:";
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

  /* Turn-end notifications, for the devices that asked for them.
     `TurnEndNotifier` reads the catalog rather than the hub for the same reason
     attention does: the hub only publishes while a client is attached, which is
     the opposite of when a notification is worth sending. See that file for why
     a finished turn is not simply a working→idle transition. */
  const turnEnd = pushService
    ? new TurnEndNotifier({
      catalog: () => backend.catalog(),
      notify: ({ agentId, outcome }) => {
        const agents = backend.catalog().agents;
        void pushService.notify(buildTurnEndPushPayload(
          agentId,
          agents.find((agent) => agent.id === agentId)?.notificationLabel,
          outcome,
          attentionAgentCount(agents),
        ), "turnEnd");
      },
    })
    : null;
  const turnEndTimer = turnEnd ? setInterval(() => turnEnd.tick(), TURN_END_POLL_MS) : null;
  turnEndTimer?.unref?.();

  /* Which agent each outstanding question belongs to. Answering one resumes
     that agent's turn, and the resolve route is given only the attention's own
     id — the catalog carries no attention ids to look it up by. */
  const attentionOwners = new Map<string, string>();

  // Push fires only on an authoritative attention request — a real
  // AttentionRequest the daemon raised and is waiting on. Never on
  // `needsInput`, which the protocol documents as an advisory guess and never
  // a queue; waking a phone for a guess teaches people to ignore the ones that
  // matter.
  if (pushService) {
    backend.onAttentionAdded?.((attention) => {
      const agents = backend.catalog().agents;
      attentionOwners.set(attention.id, attention.agentId);
      // Unbounded growth is the only risk here, and answering is not the only
      // way a request ends — one can time out or be cancelled. Keeping the map
      // to the requests the catalog still knows about bounds it by the same
      // limit the backend already enforces on pending attention.
      if (attentionOwners.size > MAX_TRACKED_ATTENTION_OWNERS) {
        const oldest = attentionOwners.keys().next().value;
        if (oldest !== undefined) attentionOwners.delete(oldest);
      }
      // `notificationLabel`, never `name`: a display name may be the first user
      // message or the daemon's recap, and neither is allowed on a lock screen.
      const payload = buildAttentionPushPayload(
        attention,
        agents.find((agent) => agent.id === attention.agentId)?.notificationLabel,
        attentionAgentCount(agents),
      );
      // This agent's news has been told, and told more specifically than
      // "finished" ever could. A turn-end behind it would be about the same
      // moment.
      turnEnd?.disarm(attention.agentId);
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

  /**
   * A rejected Origin says which origin was rejected and which setting decides.
   *
   * A bare "Origin validation failed" sent an operator who had changed
   * PRIME_WEB_PORT looking anywhere but at the allowlist, which is exactly
   * where the answer was.
   *
   * Deliberate about what it gives away. The origin echoed back is the one the
   * caller just sent, so it tells an attacker nothing it did not already know,
   * and it goes out as problem+json — never HTML — so a hostile Origin cannot
   * be reflected into a page. The allowlist itself is never named: only the
   * variable that holds it, which is documented anyway. Same-origin policy is
   * not a secret, and a failure mode nobody can diagnose is its own risk.
   */
  function rejectOrigin(res: ServerResponse, req: IncomingMessage): void {
    const origin = req.headers.origin;
    const named = typeof origin === "string" && origin.length <= 256
      ? `the origin ${JSON.stringify(origin)}`
      : "a request with no usable Origin header";
    problem(res, 403, "Origin validation failed",
      `This gateway does not accept ${named}. Set PRIME_WEB_ALLOWED_ORIGINS to the origin the browser reaches it at.`);
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
      if (!auth.isAllowedOrigin(req)) { rejectOrigin(res, req); return true; }
      const parsed = pairRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) { problem(res, 400, "Invalid pairing request"); return true; }
      const session = await auth.pair(req, res, parsed.data.token, parsed.data.deviceName);
      if (!session) { problem(res, 401, "Invalid pairing token"); return true; }
      json(res, 200, { paired: true, csrfToken: session.csrfToken });
      return true;
    }

    // Unauthenticated by design: the device cookie is the credential. It is
    // what lets a phone survive a gateway restart without being handed the
    // pairing token again, and it shares the pairing rate limit.
    if (req.method === "POST" && pathname === "/api/v1/auth/resume") {
      if (!auth.isAllowedOrigin(req)) { rejectOrigin(res, req); return true; }
      const resumed = await auth.resume(req, res);
      if (!resumed) { problem(res, 401, "No usable device credential"); return true; }
      json(res, 200, { paired: true, csrfToken: resumed.csrfToken });
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

    /**
     * Which phones may come back. Paired with `/devices/revoke` below, which is
     * a mutation and sits behind that gate; this is a read and sits with the
     * other reads, because a GET carries no CSRF header to validate.
     *
     * Neither route hands out any part of a credential — not the secret, not its
     * hash. A paired browser can already drive every agent on this machine, so
     * seeing which other devices share that power, and being able to cut one
     * off, does not widen what the browser can reach: it makes a capability the
     * operator only had by editing a JSON file reachable from the phone that
     * needs it, usually because the other phone is gone. `docs/security.md`
     * carries this.
     */
    if (req.method === "GET" && pathname === "/api/v1/devices") {
      const current = auth.deviceIdFor(session);
      json(res, 200, {
        devices: deviceStore.list().map((device) => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          current: device.id === current,
        })),
      } satisfies DeviceListSnapshot);
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
      // Every session this sign-out will reap, not only the one that asked:
      // revoking the device credential takes its siblings with it, and each of
      // them may have registered its own push subscription and its own socket.
      const reaped = auth.sessionIdsForDevice(session);
      await Promise.all(reaped.map((id) => pushStore.removeSession(id).catch((error: unknown) => {
        console.error("Could not persist push revocation on sign-out", error);
      })));
      const sockets = reaped.flatMap((id) => [...(sessionSockets.get(id) ?? [])]);
      await auth.signOut(res, session);
      // A socket keeps delivering until it is told to stop: isSessionActive is
      // only consulted on an inbound frame, and events are outbound.
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
        async () => {
          const accepted = await backend.sendMessage({ agentId, ...parsed.data, images });
          // Somebody asked this agent for work, so its next quiet is a finished
          // turn. Inside the operation, not after it: a retried request id is
          // answered from the cache without prompting the agent again.
          turnEnd?.arm(agentId);
          return accepted;
        },
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
        async () => {
          const executed = await backend.executeSlashCommand({ agentId, ...parsed.data });
          // Session and experimental commands prompt the agent like a message
          // does, so their next quiet is a finished turn. Direct commands start
          // no turn, and a cached retry (see the message route) prompts nothing.
          if (executed.result.kind === "session_accepted" || executed.result.kind === "experimental_accepted") {
            turnEnd?.arm(agentId);
          }
          return executed;
        },
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

    if (req.method === "POST" && pathname === "/api/v1/devices/revoke") {
      const parsed = revokeDeviceRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) { problem(res, 400, "Invalid device revocation request"); return true; }
      const { deviceId } = parsed.data;
      const revokingSelf = auth.deviceIdFor(session) === deviceId;
      const reaped = await auth.revokeDevice(deviceId);
      if (!reaped) { problem(res, 404, "No such device"); return true; }
      // Everything sign-out does, because this is sign-out aimed elsewhere: the
      // wake capability and the live socket both outlive the credential unless
      // they are taken too.
      //
      // By device first: `reaped` holds only sessions live in memory, and the
      // phone that matters is asleep or was paired before the last restart.
      // The session pass covers records from before they carried a device id.
      await Promise.all([
        pushStore.removeDevice(deviceId),
        ...reaped.map((id) => pushStore.removeSession(id)),
      ].map((pending) => pending.catch((error: unknown) => {
        console.error("Could not persist push revocation on device revoke", error);
      })));
      const sockets = reaped.flatMap((id) => [...(sessionSockets.get(id) ?? [])]);
      if (revokingSelf) auth.clearCredentials(res);
      for (const ws of sockets) closeWebSocket(ws, 1008, "Device revoked");
      json(res, 200, { revoked: true, self: revokingSelf });
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
              // What outlives the session, and so what a revocation can still find.
              deviceId: auth.deviceIdFor(session),
              createdAt: new Date().toISOString(),
              // Sent on every subscribe, including the one the app makes on
              // each launch to re-claim its record. A subscribe that omitted it
              // would quietly switch the preference off again.
              turnEnd: request.turnEnd === true,
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
      // Answering resumes the turn; without this the resumed turn ends silently
      // because the attention push disarmed it on the way in.
      const owner = attentionOwners.get(attentionId);
      if (owner) {
        turnEnd?.arm(owner);
        attentionOwners.delete(attentionId);
      }
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

  /**
   * Bring an agent's event stream into existence before attaching to it.
   *
   * A stream is registered as a side effect of `backend.agentSnapshot()`, so an
   * agent could sit in the catalog — real, listed, selectable — with no stream
   * of its own. `hub.attach()` cannot tell that apart from an agent that was
   * deleted: both are a missing key, and both used to be answered
   * `stream_gone`, which the web client reads as terminal. It detaches, evicts
   * the agent and then refuses the HTTP snapshot that lands afterwards, and
   * since only a WebSocket snapshot clears that state and no attach is left to
   * deliver one, the transcript spinner never resolves.
   *
   * Worst right after a restart, when the hub holds `catalog` and nothing else,
   * so every agent attach bounces until something happens to ask for a snapshot
   * first. `createSession` already registers eagerly for this exact reason; this
   * is the same guarantee for every other way an agent is reached.
   *
   * Shared across sockets and de-duplicated: projecting a snapshot can mean
   * parsing tens of megabytes of session file, and two phones attaching at once
   * must not each pay for it. After this, `stream_gone` means what it says.
   */
  const streamWarmups = new Map<string, Promise<void>>();

  function warmAgentStream(streamId: string): Promise<void> | null {
    if (hub.has(streamId) || !streamId.startsWith(AGENT_STREAM_PREFIX)) return null;
    const agentId = streamId.slice(AGENT_STREAM_PREFIX.length);
    // Catalog membership is the bound: an id nobody lists does no work here.
    if (!backend.catalog().agents.some((agent) => agent.id === agentId)) return null;
    const existing = streamWarmups.get(streamId);
    if (existing) return existing;
    const warmup = backend.agentSnapshot(agentId)
      .then(() => undefined, () => undefined)
      .finally(() => streamWarmups.delete(streamId));
    streamWarmups.set(streamId, warmup);
    return warmup;
  }

  function configureWebSocket(ws: WebSocket, session: AuthenticatedSession): void {
    const subscriptions = new Map<string, () => void>();
    /**
     * Which subscribe each pending warmup is still working for.
     *
     * Attaching to a cold stream finishes an await later, and the socket is
     * free to speak again in the meantime. Nothing recorded that: a second
     * subscribe during the same warmup joined the same shared promise and
     * added a second `.then`, so both attached — every event delivered twice,
     * and the first registration orphaned for the stream's lifetime because
     * `subscriptions` only remembers the last detach. A `detach` arriving
     * during a warmup was ignored just as completely, attaching a stream the
     * client had already given up on.
     *
     * Each subscribe claims a fresh token; a warmup only attaches while its
     * own claim is the current one. Same shape as the fix in 55ba9b9: state
     * read before an await has to be re-checked after it.
     */
    const pendingAttaches = new Map<string, symbol>();
    const finishAttach = (streamId: string, since: StreamCursor | null | undefined): void => {
      // Settle any live subscription before adding another. Two registrations
      // for one socket double-deliver, and only the newer detach is reachable.
      subscriptions.get(streamId)?.();
      subscriptions.delete(streamId);
      const attached = hub.attach(streamId, since, send);
      if (!attached) {
        send({ type: "detached", version: PROTOCOL_VERSION, streamId, reason: "stream_gone" });
        return;
      }
      subscriptions.set(streamId, attached.detach);
      send(attached.initial);
    };
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
      pendingAttaches.clear();
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
          pendingAttaches.delete(frame.streamId);
          subscriptions.get(frame.streamId)?.();
          subscriptions.delete(frame.streamId);
          return;
        }
        const streamId = frame.streamId;
        const since = frame.since;
        const warmup = warmAgentStream(streamId);
        if (warmup) {
          const claim = Symbol(streamId);
          pendingAttaches.set(streamId, claim);
          void warmup.then(() => {
            // While a large session file was being read the socket may have
            // gone, its session expired, or the client detached or asked
            // again. All are ordinary, and only the newest ask may attach.
            if (pendingAttaches.get(streamId) !== claim) return;
            pendingAttaches.delete(streamId);
            if (ws.readyState !== ws.OPEN || !auth.isSessionActive(session)) return;
            finishAttach(streamId, since);
          });
          return;
        }
        pendingAttaches.delete(streamId);
        finishAttach(streamId, since);
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
    if (turnEndTimer) clearInterval(turnEndTimer);
    hub.close();
    await backend.close();
    for (const client of wss.clients) client.close(1001, "Server shutdown");
    // `close()` only *asks*. A peer that is asleep, or whose network went away
    // mid-session, never answers — and an upgraded socket is no longer tracked
    // by the HTTP server, so neither `close()` nor `closeAllConnections()`
    // reaches it. It holds the listening port until something gives up on it,
    // which made a stop-then-start collide with the port it had just released.
    // A live peer closes in a millisecond or two; anything still here after the
    // grace is not going to answer.
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 10).unref(); });
    }
    for (const client of wss.clients) client.terminate();
  }

  return { requestListener, upgradeListener, backend, hub, auth, pushStore, turnEnd, shutdown };
}
