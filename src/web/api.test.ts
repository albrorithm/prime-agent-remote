import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, createSession, executeSlashCommand, loadSlashCommandCatalog, onUnauthorized } from "./api";

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
