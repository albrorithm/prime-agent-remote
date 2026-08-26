import { z, type ZodType } from "zod";
import {
  agentSnapshotSchema,
  bootstrapResponseSchema,
  cellOutputSchema,
  directoryListingSchema,
  mutationAcceptedSchema,
  problemDetailsSchema,
  pushAcceptedSchema,
  sessionCreatedSchema,
  slashCommandAcceptedSchema,
  slashCommandCatalogSchema,
  type AgentSnapshot,
  type BootstrapResponse,
  type CellOutput,
  type DirectoryListing,
  type ImageAttachmentInput,
  type MutationAccepted,
  type ProblemDetails,
  type PushAccepted,
  type SessionCreated,
  type SlashCommandAccepted,
  type SlashCommandCatalog,
} from "../protocol";

export const API_REQUEST_TIMEOUT_MS = 15_000;

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Keep a 401 from reaching the central `onUnauthorized` handlers.
   *
   * A caller that answers 401 itself — by spending the device credential on a
   * new session — has to, because those handlers tear the session down
   * synchronously while this request is still unwinding, and the caller's own
   * catch never gets to run.
   */
  ownsUnauthorized?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Browser fetch failures (offline, DNS, CORS, dev server down) throw a bare
// TypeError whose message is developer-speak ("Failed to fetch", "fetch
// failed", "NetworkError when attempting to fetch resource", "Load failed").
// ApiError messages already come from the gateway's problem-details body
// (see decode() below) and are human-facing as-is.
const NETWORK_ERROR_PATTERN = /fetch failed|failed to fetch|networkerror|load failed/i;

/** Turn a thrown value into UI-safe copy instead of letting a raw Error.message through. */
export function humanizeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error && NETWORK_ERROR_PATTERN.test(error.message)) {
    return "Can't reach the gateway. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/** Register a central session-expiry handler. Returns an unsubscribe function. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

async function decode<T>(response: Response, schema?: ZodType<T>, ownsUnauthorized = false): Promise<T> {
  if (!response.ok) {
    const rawProblem = await response.json().catch(() => null) as unknown;
    const parsedProblem = rawProblem === null ? null : problemDetailsSchema.safeParse(rawProblem);
    // A malformed or unparseable error body must not itself throw and mask the real HTTP error,
    // so fall back to the raw (unchecked) value, and ultimately to a generic message, on parse failure.
    const problem: ProblemDetails | null = parsedProblem?.success
      ? parsedProblem.data
      : (rawProblem as ProblemDetails | null);
    if (response.status === 401 && !ownsUnauthorized) {
      for (const handler of unauthorizedHandlers) handler();
    }
    throw new ApiError(response.status, problem?.detail || problem?.title || `HTTP ${response.status}`);
  }
  const value = await response.json() as unknown;
  if (!schema) return value as T;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(502, "The server returned invalid data");
  return parsed.data;
}

async function request<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  options: ApiRequestOptions = {},
  schema?: ZodType<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? API_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await decode(response, schema, options.ownsUnauthorized);
  } catch (error) {
    if (timedOut) throw new ApiError(408, "The request timed out");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

// `pair()`'s response shape isn't a named DTO in protocol.ts, so its schema lives here
// rather than there — it's still validated so no exported function falls through to
// decode()'s unchecked-cast fallback.
const pairResponseSchema = z.object({ csrfToken: z.string() });

export async function pair(token: string, options?: ApiRequestOptions): Promise<{ csrfToken: string }> {
  return request("/api/v1/auth/pair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }, options, pairResponseSchema);
}

/**
 * Exchanges the device credential this browser already holds for a new
 * session. Carries no body: the cookie is the credential. A 401 means there is
 * nothing usable, which is the ordinary state before a device has ever paired.
 */
export async function resume(options?: ApiRequestOptions): Promise<{ csrfToken: string }> {
  return request("/api/v1/auth/resume", {
    method: "POST",
    credentials: "same-origin",
  }, options, pairResponseSchema);
}

const signOutResponseSchema = z.object({ signedOut: z.literal(true) });

export async function signOut(csrfToken: string, options?: ApiRequestOptions): Promise<void> {
  await mutate("/api/v1/auth/logout", csrfToken, {}, options, signOutResponseSchema);
}

export async function bootstrap(options?: ApiRequestOptions): Promise<BootstrapResponse> {
  return request("/api/v1/bootstrap", {
    credentials: "same-origin",
    cache: "no-store",
  }, options, bootstrapResponseSchema);
}

export async function loadAgent(agentId: string, options?: ApiRequestOptions): Promise<AgentSnapshot> {
  return request(`/api/v1/agents/${encodeURIComponent(agentId)}/snapshot`, {
    credentials: "same-origin",
    cache: "no-store",
  }, options, agentSnapshotSchema);
}

/** Full, untruncated sections of a python cell that was inlined with caps. */
export async function loadCellOutput(cellId: string, options?: ApiRequestOptions): Promise<CellOutput> {
  return request(`/api/v1/cells/${encodeURIComponent(cellId)}`, {
    credentials: "same-origin",
    cache: "no-store",
  }, options, cellOutputSchema);
}

async function mutate<T = MutationAccepted>(
  path: string,
  csrfToken: string,
  body: unknown,
  options?: ApiRequestOptions,
  schema: ZodType<T> = mutationAcceptedSchema as unknown as ZodType<T>,
): Promise<T> {
  return request<T>(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
  }, options, schema);
}

export function sendMessage(
  agentId: string,
  csrfToken: string,
  expectedRevision: number,
  text: string,
  images: ImageAttachmentInput[] = [],
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/messages`, csrfToken, {
    requestId,
    expectedRevision,
    text,
    images,
  }, options, mutationAcceptedSchema);
}

export async function loadSlashCommandCatalog(
  agentId: string,
  options?: ApiRequestOptions,
): Promise<SlashCommandCatalog> {
  return request(`/api/v1/agents/${encodeURIComponent(agentId)}/commands`, {
    credentials: "same-origin",
    cache: "no-store",
  }, options, slashCommandCatalogSchema);
}

export function executeSlashCommand(
  agentId: string,
  csrfToken: string,
  expectedRevision: number,
  name: string,
  args: string,
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
): Promise<SlashCommandAccepted> {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/commands`, csrfToken, {
    requestId,
    expectedRevision,
    name,
    args,
  }, options, slashCommandAcceptedSchema);
}

export function abortAgent(
  agentId: string,
  csrfToken: string,
  expectedRevision: number,
  options?: ApiRequestOptions,
) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/abort`, csrfToken, {
    requestId: crypto.randomUUID(),
    expectedRevision,
  }, options, mutationAcceptedSchema);
}

export function renameAgent(
  agentId: string,
  csrfToken: string,
  expectedRevision: number,
  name: string,
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/rename`, csrfToken, {
    requestId,
    expectedRevision,
    name,
  }, options, mutationAcceptedSchema);
}

export function stopAgent(
  agentId: string,
  csrfToken: string,
  expectedRevision: number,
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/stop`, csrfToken, {
    requestId,
    expectedRevision,
  }, options, mutationAcceptedSchema);
}

/**
 * Irreversible. `confirmName` is the name the user typed to confirm; the
 * gateway refuses if it is not the session's current name, so a stale catalog
 * deletes nothing rather than the wrong session.
 */
export function deleteAgent(
  agentId: string,
  csrfToken: string,
  expectedRevision: number,
  confirmName: string,
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/delete`, csrfToken, {
    requestId,
    expectedRevision,
    confirmName,
  }, options, mutationAcceptedSchema);
}

export function respondToAttention(
  attentionId: string,
  csrfToken: string,
  expectedRevision: number,
  optionId: string,
  options?: ApiRequestOptions,
) {
  return mutate(`/api/v1/attention/${encodeURIComponent(attentionId)}/respond`, csrfToken, {
    requestId: crypto.randomUUID(),
    expectedRevision,
    optionId,
  }, options, mutationAcceptedSchema);
}

export async function listDirectories(path?: string, options?: ApiRequestOptions): Promise<DirectoryListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request(`/api/v1/directories${query}`, {
    credentials: "same-origin",
    cache: "no-store",
  }, options, directoryListingSchema);
}

export function createSession(
  csrfToken: string,
  cwd: string,
  name: string | undefined,
  requestId: string,
  options?: ApiRequestOptions,
): Promise<SessionCreated> {
  return mutate<SessionCreated>("/api/v1/sessions", csrfToken, {
    requestId,
    cwd,
    ...(name ? { name } : {}),
  }, options, sessionCreatedSchema);
}

export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function subscribeToPush(
  csrfToken: string,
  subscription: PushSubscriptionBody,
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
): Promise<PushAccepted> {
  return mutate<PushAccepted>("/api/v1/push/subscribe", csrfToken, {
    requestId,
    subscription,
  }, options, pushAcceptedSchema);
}

export function unsubscribeFromPush(
  csrfToken: string,
  endpoint: string,
  requestId: string = crypto.randomUUID(),
  options?: ApiRequestOptions,
): Promise<PushAccepted> {
  return mutate<PushAccepted>("/api/v1/push/unsubscribe", csrfToken, {
    requestId,
    endpoint,
  }, options, pushAcceptedSchema);
}
