import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, createSession, deleteAgent, executeSlashCommand, listDirectories, loadSlashCommandCatalog, onUnauthorized, renameAgent, resume, signOut, stopAgent } from "./api";

const requestId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("slash command API", () => {
  it("loads the authenticated no-store catalog", async () => {
    const catalog = { agentId: "agent-1", agentRevision: 3, partial: false, commands: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSlashCommandCatalog("agent-1")).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/agent-1/commands", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }));
  });

  it("uses only the strict command endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      requestId,
      revision: 4,
      result: { kind: "model", provider: "openai", modelId: "example" },
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await executeSlashCommand("agent-1", "csrf", 3, "model", "openai/example", requestId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/agents/agent-1/commands");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      requestId,
      expectedRevision: 3,
      name: "model",
      args: "openai/example",
    });
  });

  it("fails closed when the command route is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ title: "API route not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeSlashCommand("agent-1", "csrf", 3, "goal", "status", requestId)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed slash command catalog as invalid server data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agentId: "agent-1",
      agentRevision: 3,
      partial: false,
      commands: [{ name: "goal", description: "Manage the goal", source: "session", availability: "sometimes", takesArguments: true }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(loadSlashCommandCatalog("agent-1")).rejects.toMatchObject({
      status: 502,
      message: "The server returned invalid data",
    });
  });

  it("rejects a malformed slash command acceptance as invalid server data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      requestId,
      revision: 4,
      result: { kind: "heartbeat", status: "sleeping" },
    }), { status: 202, headers: { "Content-Type": "application/json" } })));

    await expect(executeSlashCommand("agent-1", "csrf", 3, "heartbeat", "", requestId)).rejects.toMatchObject({
      status: 502,
      message: "The server returned invalid data",
    });
  });
});

describe("directory listing API", () => {
  it("loads a well-formed directory listing", async () => {
    const listing = {
      path: "/workspace",
      home: "/home/user",
      crumbs: [{ name: "workspace", path: "/workspace", hidden: false }],
      entries: [{ name: "src", path: "/workspace/src", hidden: false }],
      truncated: false,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(listing), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(listDirectories("/workspace")).resolves.toEqual(listing);
  });

  it("rejects a directory listing missing a required field as invalid server data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: "/workspace",
      home: "/home/user",
      crumbs: [],
      entries: [{ name: "src", path: "/workspace/src" }],
      truncated: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(listDirectories("/workspace")).rejects.toMatchObject({
      status: 502,
      message: "The server returned invalid data",
    });
  });
});


describe("request safety", () => {
  it("rejects a bootstrap with the wrong runtime protocol version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocolVersion: 2,
      csrfToken: "csrf",
      backend: "demo",
      catalog: { revision: 0, agents: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(bootstrap()).rejects.toMatchObject({ status: 502 });
  });

  it("falls back to a generic message when the error body doesn't match ProblemDetails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "not-a-number",
    }), { status: 500, headers: { "Content-Type": "application/json" } })));

    await expect(bootstrap()).rejects.toMatchObject({ status: 500, message: "HTTP 500" });
  });

  it("notifies the central auth handler on any 401", async () => {
    const expired = vi.fn();
    const unsubscribe = onUnauthorized(expired);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: "Sign in again",
    }), { status: 401, headers: { "Content-Type": "application/json" } })));

    await expect(loadSlashCommandCatalog("agent-1")).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("aborts a request at its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const pending = expect(bootstrap({ timeoutMs: 25 })).rejects.toEqual(expect.objectContaining({
      status: 408,
      message: "The request timed out",
    }));
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    vi.useRealTimers();
  });

  it("forwards caller cancellation to fetch", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const pending = expect(bootstrap({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await pending;
  });

  it("uses a caller-retained session request id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ requestId, agentId: "agent-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession("csrf", "/workspace", "Example", requestId);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      requestId,
      cwd: "/workspace",
      name: "Example",
    });
  });
});

describe("sign out", () => {
  it("posts an authenticated logout the gateway can attribute to the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ signedOut: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signOut("csrf")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/logout");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": "csrf" },
    });
  });

  it("surfaces a rejected sign-out instead of reporting success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ title: "Origin or CSRF validation failed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signOut("stale")).rejects.toThrow("Origin or CSRF validation failed");
  });
});

describe("renameAgent", () => {
  it("posts the name to the agent's own rename route with the CSRF header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      requestId,
      revision: 5,
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameAgent("agent/1", "csrf", 4, "New name", requestId))
      .resolves.toEqual({ accepted: true, requestId, revision: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The id is a path segment, so it is encoded rather than interpolated raw.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/agents/agent%2F1/rename");
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["X-CSRF-Token"]).toBe("csrf");
    expect(JSON.parse(init.body as string)).toEqual({ requestId, expectedRevision: 4, name: "New name" });
  });

  it("rejects a refused rename rather than resolving", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: "about:blank",
      title: "Action is not allowed",
      status: 403,
    }), { status: 403, headers: { "Content-Type": "application/problem+json" } })));

    await expect(renameAgent("agent-1", "csrf", 4, "New name", requestId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("stopAgent", () => {
  it("posts to the agent's own stop route and carries nothing else", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      requestId,
      revision: 2,
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await stopAgent("agent-1", "csrf", 1, requestId);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/agents/agent-1/stop");
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["X-CSRF-Token"]).toBe("csrf");
    expect(JSON.parse(init.body as string)).toEqual({ requestId, expectedRevision: 1 });
  });
});

describe("deleteAgent", () => {
  it("carries the confirming name to the agent's own delete route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      requestId,
      revision: 9,
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteAgent("agent-1", "csrf", 8, "Previous session", requestId);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/agents/agent-1/delete");
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["X-CSRF-Token"]).toBe("csrf");
    expect(JSON.parse(init.body as string)).toEqual({
      requestId,
      expectedRevision: 8,
      confirmName: "Previous session",
    });
  });
});

describe("resume", () => {
  it("posts no body, because the device cookie is the credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ csrfToken: "fresh" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resume()).resolves.toEqual({ csrfToken: "fresh" });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/resume", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("rejects when the gateway has no usable credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(resume()).rejects.toThrow();
  });
});
