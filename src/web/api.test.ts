import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSessionSlashCommand } from "./api";

const requestId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session slash command API", () => {
  it("uses the strict command endpoint when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accepted: true,
      requestId,
      revision: 4,
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await executeSessionSlashCommand("agent-1", "csrf", 3, "goal", "status", requestId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/agents/agent-1/commands");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      requestId,
      expectedRevision: 3,
      name: "goal",
      args: "status",
    });
  });

  it("falls back to the existing prompt route only when the command route is absent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: "API route not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, requestId, revision: 3 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await executeSessionSlashCommand("agent-1", "csrf", 3, "refine", "--global", requestId);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/agents/agent-1/messages");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      requestId,
      expectedRevision: 3,
      text: "/refine --global",
      images: [],
    });
  });
});
