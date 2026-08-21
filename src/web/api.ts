import type {
  AgentSnapshot,
  BootstrapResponse,
  DirectoryListing,
  MutationAccepted,
  ProblemDetails,
  SessionCreated,
} from "../protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function decode<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(response.status, problem?.detail || problem?.title || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function pair(token: string): Promise<{ csrfToken: string }> {
  return decode(
    await fetch("/api/v1/auth/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
}

export async function bootstrap(): Promise<BootstrapResponse> {
  return decode(await fetch("/api/v1/bootstrap", { credentials: "same-origin", cache: "no-store" }));
}

export async function loadAgent(agentId: string): Promise<AgentSnapshot> {
  return decode(
    await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/snapshot`, {
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
}

async function mutate<T = MutationAccepted>(path: string, csrfToken: string, body: unknown): Promise<T> {
  return decode(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(body),
    }),
  );
}

export function sendMessage(agentId: string, csrfToken: string, expectedRevision: number, text: string) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/messages`, csrfToken, {
    requestId: crypto.randomUUID(),
    expectedRevision,
    text,
  });
}

export function abortAgent(agentId: string, csrfToken: string, expectedRevision: number) {
  return mutate(`/api/v1/agents/${encodeURIComponent(agentId)}/abort`, csrfToken, {
    requestId: crypto.randomUUID(),
    expectedRevision,
  });
}

export function respondToAttention(
  attentionId: string,
  csrfToken: string,
  expectedRevision: number,
  optionId: string,
) {
  return mutate(`/api/v1/attention/${encodeURIComponent(attentionId)}/respond`, csrfToken, {
    requestId: crypto.randomUUID(),
    expectedRevision,
    optionId,
  });
}

export async function listDirectories(path?: string): Promise<DirectoryListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return decode(await fetch(`/api/v1/directories${query}`, { credentials: "same-origin", cache: "no-store" }));
}

export function createSession(csrfToken: string, cwd: string, name?: string): Promise<SessionCreated> {
  return mutate<SessionCreated>("/api/v1/sessions", csrfToken, {
    requestId: crypto.randomUUID(),
    cwd,
    ...(name ? { name } : {}),
  });
}
