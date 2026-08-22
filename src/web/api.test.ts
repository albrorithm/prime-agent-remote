import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSlashCommand, loadSlashCommandCatalog } from "./api";

const requestId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
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
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/agent-1/commands", {
      credentials: "same-origin",
      cache: "no-store",
    });
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
