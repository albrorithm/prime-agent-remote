// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSnapshotSchema, catalogSnapshotSchema } from "../protocol.js";
import type { AgentSnapshot, ServerFrame } from "../protocol.js";
import { BackendCapabilityError, BackendConflictError, BackendNotFoundError } from "./backend.js";
import { DemoBackend } from "./demo-backend.js";
import { EventHub } from "./event-hub.js";
import { validateImageAttachments } from "./image-attachments.js";

const JPEG_DATA = "/9j/wAALCAABAAEBAREA/9oACAEBAAA/AAD/2Q==";

afterEach(() => vi.useRealTimers());

describe("DemoBackend", () => {
  it("marks a superseded streaming response failed and only completes the replacement", async () => {
    vi.useFakeTimers();
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    const agentId = "root-mobile";
    const initial = await backend.agentSnapshot(agentId);

    const first = await backend.sendMessage({
      agentId,
      requestId: crypto.randomUUID(),
      expectedRevision: initial!.revision,
      text: "first",
      images: [],
    });
    const second = await backend.sendMessage({
      agentId,
      requestId: crypto.randomUUID(),
      expectedRevision: first.revision,
      text: "second",
      images: [],
    });

    const superseded = (await backend.agentSnapshot(agentId))!.messages
      .filter((message) => message.role === "assistant").at(-2);
    expect(superseded).toMatchObject({ state: "failed", text: "Superseded by a newer message." });
    expect(second.revision).toBe(first.revision + 2);

    await vi.advanceTimersByTimeAsync(2_000);
    const assistants = (await backend.agentSnapshot(agentId))!.messages.filter((message) => message.role === "assistant");
    expect(assistants.at(-2)?.state).toBe("failed");
    expect(assistants.at(-1)?.state).toBe("complete");
    await backend.close();
    hub.close();
  });

  it("rejects image attachments without changing the snapshot", async () => {
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    const snapshot = await backend.agentSnapshot("root-mobile");
    const images = validateImageAttachments([{ type: "image", mimeType: "image/jpeg", data: JPEG_DATA }]);

    await expect(backend.sendMessage({
      agentId: "root-mobile",
      requestId: crypto.randomUUID(),
      expectedRevision: snapshot!.revision,
      text: "image",
      images,
    })).rejects.toBeInstanceOf(BackendCapabilityError);
    expect((await backend.agentSnapshot("root-mobile"))?.revision).toBe(snapshot?.revision);
    await backend.close();
    hub.close();
  });

  it("serializes direct commands and advances revisions for mutations", async () => {
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    const snapshot = await backend.agentSnapshot("root-mobile");
    const execute = () => backend.executeSlashCommand({
      agentId: "root-mobile",
      requestId: crypto.randomUUID(),
      expectedRevision: snapshot!.revision,
      name: "model",
      args: "demo/fast",
    });

    const results = await Promise.allSettled([execute(), execute()]);
    const fulfilled = results.find((result) => result.status === "fulfilled");
    expect(fulfilled).toMatchObject({ status: "fulfilled", value: { revision: snapshot!.revision + 1 } });
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(BackendConflictError) });
    expect((await backend.agentSnapshot("root-mobile"))?.revision).toBe(snapshot!.revision + 1);
    await backend.close();
    hub.close();
  });

  it("caps demo session creation without evicting built-in agents", async () => {
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    const builtInIds = backend.catalog().agents.map((agent) => agent.id);
    try {
      for (let index = builtInIds.length; index < 128; index += 1) {
        await backend.createSession({
          requestId: crypto.randomUUID(),
          cwd: "/Documents",
          name: `Bounded demo ${index}`,
        });
      }
      expect(backend.catalog().agents).toHaveLength(128);
      expect(backend.catalog().agents.slice(0, builtInIds.length).map((agent) => agent.id)).toEqual(builtInIds);
      await expect(backend.createSession({
        requestId: crypto.randomUUID(),
        cwd: "/Documents",
        name: "Over the cap",
      })).rejects.toThrow("Demo session limit reached");
      expect(backend.catalog().agents).toHaveLength(128);
      expect(Buffer.byteLength(JSON.stringify(backend.catalog()), "utf8")).toBeLessThan(1024 * 1024);
    } finally {
      await backend.close();
      hub.close();
    }
  });

  it("trims old completed transcript content while preserving the active turn", async () => {
    vi.useFakeTimers();
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    const agentId = "root-mobile";
    let revision = (await backend.agentSnapshot(agentId))!.revision;
    let lastRequestId = "";
    let clientSnapshot: AgentSnapshot | undefined;
    const applyFrame = (frame: ServerFrame) => {
      if (frame.type !== "event") return;
      const event = frame.envelope.event;
      if (event.kind === "agent.replaced") {
        clientSnapshot = structuredClone(event.payload);
      } else if ((event.kind === "agent.message_added" || event.kind === "agent.message_updated") && clientSnapshot) {
        const index = clientSnapshot.messages.findIndex((message) => message.id === event.payload.id);
        if (index >= 0) clientSnapshot.messages[index] = structuredClone(event.payload);
        else clientSnapshot.messages.push(structuredClone(event.payload));
      }
    };
    const attached = hub.attach(`agent:${agentId}`, null, applyFrame);
    if (attached?.initial.type === "snapshot") clientSnapshot = structuredClone(attached.initial.snapshot as AgentSnapshot);
    try {
      for (let index = 0; index < 25; index += 1) {
        lastRequestId = crypto.randomUUID();
        const accepted = await backend.sendMessage({
          agentId,
          requestId: lastRequestId,
          expectedRevision: revision,
          text: `${index}:`.padEnd(100_000, "x"),
          images: [],
        });
        revision = accepted.revision;
      }
      const snapshot = (await backend.agentSnapshot(agentId))!;
      expect(snapshot.messages.length).toBeLessThanOrEqual(256);
      expect(snapshot.messages.reduce((total, message) => total + message.text.length, 0))
        .toBeLessThanOrEqual(2 * 1024 * 1024);
      const streamingIndex = snapshot.messages.findIndex((message) => message.state === "streaming");
      expect(streamingIndex).toBeGreaterThan(0);
      expect(snapshot.messages[streamingIndex - 1]).toMatchObject({ id: lastRequestId, role: "user" });
      expect(snapshot.messages.filter((message) => message.state === "streaming")).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThan(4 * 1024 * 1024);
      expect(clientSnapshot?.messages.map((message) => message.id))
        .toEqual(snapshot.messages.map((message) => message.id));
      expect(clientSnapshot?.messages.reduce((total, message) => total + message.text.length, 0))
        .toBeLessThanOrEqual(2 * 1024 * 1024);
    } finally {
      attached?.detach();
      await backend.close();
      hub.close();
    }
  });


  it("publishes a replacement when a streaming chunk triggers transcript trimming", async () => {
    vi.useFakeTimers();
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    const agentId = "root-mobile";
    try {
      const initial = (await backend.agentSnapshot(agentId))!;
      await backend.sendMessage({
        agentId,
        requestId: crypto.randomUUID(),
        expectedRevision: initial.revision,
        text: "stream this",
        images: [],
      });
      const internal = (Reflect.get(backend, "snapshots") as Map<string, AgentSnapshot>).get(agentId)!;
      const currentChars = internal.messages.reduce((total, message) => total + message.text.length, 0);
      internal.messages.unshift({
        id: "old-large-message",
        role: "system",
        text: "x".repeat(2 * 1024 * 1024 - currentChars - 1),
        state: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      hub.register(`agent:${agentId}`, internal);
      const frames: ServerFrame[] = [];
      const attached = hub.attach(`agent:${agentId}`, null, (frame) => frames.push(frame));

      await vi.advanceTimersByTimeAsync(500);

      expect(frames).toContainEqual(expect.objectContaining({
        type: "event",
        envelope: expect.objectContaining({ event: expect.objectContaining({ kind: "agent.replaced" }) }),
      }));
      expect((await backend.agentSnapshot(agentId))?.messages.some((message) => message.id === "old-large-message"))
        .toBe(false);
      attached?.detach();
    } finally {
      await backend.close();
      hub.close();
    }
  });

  it("emits snapshots that validate against the widened protocol schemas", async () => {
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const catalog = backend.catalog();
      expect(catalogSnapshotSchema.safeParse(catalog).success).toBe(true);
      expect(catalog.agents.length).toBeGreaterThan(0);
      for (const agent of catalog.agents) {
        const snapshot = await backend.agentSnapshot(agent.id);
        const parsed = agentSnapshotSchema.safeParse(snapshot);
        expect(parsed.success, agent.id).toBe(true);
        expect(snapshot?.dashboard, agent.id).toBeDefined();
      }
      const inactive = await backend.agentSnapshot("root-inactive");
      expect(inactive?.dashboard?.status).toBe("inactive");
      const dialog = await backend.agentSnapshot("child-review");
      expect(dialog?.attention[0]).toMatchObject({
        kind: "dialog",
        options: [
          { id: "__demo_cancel__", label: "Decline", tone: "danger" },
          { id: "confirm", label: "Confirm", tone: "safe" },
        ],
      });
    } finally {
      await backend.close();
      hub.close();
    }
  });

  it("renames a live and an inactive session, and publishes both", async () => {
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const catalogFrames: unknown[] = [];
      hub.attach("catalog", null, (frame) => catalogFrames.push(frame));

      for (const agentId of ["root-mobile", "root-inactive"]) {
        const snapshot = await backend.agentSnapshot(agentId);
        const result = await backend.rename({
          agentId,
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot!.revision,
          name: `Renamed ${agentId}`,
        });
        expect(result.revision).toBe(snapshot!.revision + 1);
        expect(backend.catalog().agents.find((agent) => agent.id === agentId)?.name).toBe(`Renamed ${agentId}`);
      }

      // An inactive session can be renamed without being woken.
      expect(backend.catalog().agents.find((agent) => agent.id === "root-inactive")?.lifecycle).toBe("inactive");
      expect(catalogFrames.length).toBeGreaterThan(0);

      const stale = await backend.agentSnapshot("root-mobile");
      await expect(backend.rename({
        agentId: "root-mobile",
        requestId: crypto.randomUUID(),
        expectedRevision: stale!.revision - 1,
        name: "Should conflict",
      })).rejects.toBeInstanceOf(BackendConflictError);

      await expect(backend.rename({
        agentId: "no-such-agent",
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
        name: "Nowhere",
      })).rejects.toBeInstanceOf(BackendNotFoundError);
    } finally {
      await backend.close();
      hub.close();
    }
  });

  it("never advertises a capability it has no method for", async () => {
    // The UI decides what to put on screen from these bits, so an advertised
    // capability with nothing behind it is a control that fails when pressed.
    // Keyed off the backend method rather than a literal expectation, so this
    // stays honest as each operation lands instead of needing an edit per bit.
    const backedBy: Record<string, keyof DemoBackend> = {
      abort: "abort",
      rename: "rename",
      stop: "stop",
      deactivate: "deactivate",
      delete: "delete",
    };
    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      for (const agent of backend.catalog().agents) {
        for (const [capability, method] of Object.entries(backedBy)) {
          if (typeof (backend as unknown as Record<string, unknown>)[method] === "function") continue;
          expect(
            agent.capabilities[capability as keyof typeof agent.capabilities],
            `${agent.id} advertises ${capability} with no ${method}()`,
          ).toBe(false);
        }
      }
    } finally {
      await backend.close();
      hub.close();
    }
  });

  it("covers every TranscriptPresentation kind in the demo snapshots (WS10)", async () => {
    // Derive the kind list from the protocol schema itself (rather than a
    // hand-copied literal list) so a future presentation kind fails this
    // test until it's demoed, instead of silently going unchecked.
    const messageSchema = (agentSnapshotSchema.shape.messages as unknown as { element: PresentationHost }).element;
    const presentationUnion = (messageSchema.shape.presentation as unknown as { unwrap(): DiscriminatedUnion }).unwrap();
    const expectedKinds = presentationUnion.options.map((option) => option.shape.kind.value);
    expect(expectedKinds.sort()).toEqual(["error", "notice", "python", "refine", "thinking", "tool"]);

    const backend = new DemoBackend();
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const seenKinds = new Set<string>();
      for (const summary of backend.catalog().agents) {
        const snapshot = await backend.agentSnapshot(summary.id);
        for (const message of snapshot?.messages ?? []) {
          if (message.presentation) seenKinds.add(message.presentation.kind);
        }
      }
      for (const kind of expectedKinds) {
        expect(seenKinds.has(kind), `missing demo fixture for presentation kind "${kind}"`).toBe(true);
      }

      // Dashboard richness (SessionDashboard fixture, point 6 of the WS10 brief).
      const mobile = await backend.agentSnapshot("root-mobile");
      expect(mobile?.dashboard).toMatchObject({
        status: expect.any(String),
        needsInput: false,
        contextUsage: expect.objectContaining({ tokens: expect.any(Number) }),
      });
      expect(mobile?.dashboard?.children.length).toBeGreaterThan(0);
      expect(mobile?.dashboard?.refines.length).toBeGreaterThan(0);
      const childProtocol = await backend.agentSnapshot("child-protocol");
      expect(childProtocol?.dashboard?.needsInput).toBe(true);

      // turnId grouping: the seeded transcript spans several settled turns
      // plus a live one, including a turn opened by a slash command.
      const turnIds = (mobile?.messages ?? []).map((message) => message.turnId).filter(Boolean);
      expect(new Set(turnIds).size).toBeGreaterThanOrEqual(4);
      const slashTurn = mobile?.messages.find((message) => message.text === "/refine");
      expect(slashTurn?.turnId).toBe(slashTurn?.id);

      // The cellId whose full sections come back via cellOutput().
      const truncatedCell = mobile?.messages.find(
        (message) => message.presentation?.kind === "python" && message.presentation.codeTruncated,
      );
      expect(truncatedCell?.presentation).toMatchObject({ kind: "python", cellId: expect.any(String) });
      const cellId = truncatedCell?.presentation?.kind === "python" ? truncatedCell.presentation.cellId : undefined;
      const full = cellId ? backend.cellOutput(cellId) : null;
      expect(full?.truncated).toBe(false);
      expect(full?.code?.length ?? 0).toBeGreaterThan(truncatedCell?.presentation?.kind === "python" ? (truncatedCell.presentation.code?.length ?? 0) : 0);

      // Live streaming python cell.
      const liveCell = mobile?.messages.find((message) => message.presentation?.kind === "python" && message.presentation.status === "running");
      expect(liveCell?.state).toBe("streaming");
    } finally {
      await backend.close();
      hub.close();
    }
  });

});

interface DiscriminatedUnion {
  options: Array<{ shape: { kind: { value: string } } }>;
}

interface PresentationHost {
  shape: { presentation: { unwrap(): DiscriminatedUnion } };
}
