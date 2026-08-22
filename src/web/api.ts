import type { ZodType } from "zod";
import {
  agentSnapshotSchema,
  bootstrapResponseSchema,
  type AgentSnapshot,
  type BootstrapResponse,
  type DirectoryListing,
  type ImageAttachmentInput,
  type MutationAccepted,
  type ProblemDetails,
  type SessionCreated,
  type SlashCommandAccepted,
  type SlashCommandCatalog,
} from "../protocol";

export const API_REQUEST_TIMEOUT_MS = 15_000;

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/** Register a central session-expiry handler. Returns an unsubscribe function. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

async function decode<T>(response: Response, schema?: ZodType<T>): Promise<T> {
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    if (response.status === 401) {
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
    return await decode(response, schema);
  } catch (error) {
    if (timedOut) throw new ApiError(408, "The request timed out");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function pair(token: string, options?: ApiRequestOptions): Promise<{ csrfToken: string }> {
  return request<{ csrfToken: string }>("/api/v1/auth/pair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }, options);
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

async function mutate<T = MutationAccepted>(
  path: string,
  csrfToken: string,
  body: unknown,
  options?: ApiRequestOptions,
): Promise<T> {
  return request<T>(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
  }, options);
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
  }, options);
}

export async function loadSlashCommandCatalog(
  agentId: string,
  options?: ApiRequestOptions,
): Promise<SlashCommandCatalog> {
  return request<SlashCommandCatalog>(`/api/v1/agents/${encodeURIComponent(agentId)}/commands`, {
    credentials: "same-origin",
    cache: "no-store",
  }, options);
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
  }, options);
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
  }, options);
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
  }, options);
}

export async function listDirectories(path?: string, options?: ApiRequestOptions): Promise<DirectoryListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<DirectoryListing>(`/api/v1/directories${query}`, {
    credentials: "same-origin",
    cache: "no-store",
  }, options);
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
  }, options);
}
