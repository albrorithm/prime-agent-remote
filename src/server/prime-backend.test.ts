import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_REQUEST_BASE64_CHARS } from "../protocol.js";
import type { AttentionRequest, ServerFrame } from "../protocol.js";
import { BackendCapabilityError, BackendConflictError } from "./backend.js";
import { EventHub } from "./event-hub.js";
import { validateImageAttachments } from "./image-attachments.js";
import { PrimeBackend, projectPrimeTranscript, projectSavedSessionTranscript } from "./prime-backend.js";

const FIXTURE_JPEG_DATA = "/9j/wAALCAABAAEBAREA/9oACAEBAAA/AAD/2Q==";

interface FixtureState {
  sessions: Array<Record<string, unknown>>;
  snapshot: Record<string, unknown>;
  attachOptions: Record<string, unknown> | null;
  attachCount: number;
  attachDelayMs: number;
  snapshotDelayMs: number;
  adapterDelayMs: number;
  prompts: Array<{ message: string; options?: Record<string, unknown> }>;
  promptError?: Error;
  commands: Array<Record<string, unknown>>;
  availableModels: Array<Record<string, unknown>>;
  connectionState: Record<string, unknown>;
  sessionStats: Record<string, unknown>;
  heartbeat?: Record<string, unknown>;
  adapterCalls: Array<Record<string, unknown>>;
  aborts: number;
  responses: unknown[];
  creates: Array<Record<string, unknown>>;
  savedRenames: Array<Record<string, unknown>>;
  savedRenameError?: string;
  listener: ((event: unknown) => void) | null;
  createError?: string;
  listError: boolean;
  connectError: boolean;
  snapshotError: boolean;
  clientsCreated: number;
  clientsClosed: number;
  /** Clients numbered at or below this stay dead, like sockets left over from a daemon restart. */
  failClientsBelow: number;
  listDelayMs: number;
  listCalls: number;
  activeListRequests: number;
  maxConcurrentListRequests: number;
  snapshotCalls: number;
  activeSnapshotRequests: number;
  maxConcurrentSnapshotRequests: number;
  disposed: number;
  responseDelayMs: number;
}

const fixture: FixtureState = {
  sessions: [{
    id: "daemon-row",
    sessionId: "private-session",
    activeSessionId: "private-active",
    sessionName: "Live agent",
    activity: "working",
    isSessionActive: true,
    unfinishedActionCount: 2,
    taskState: "needs_input",
    cwd: "/projects/alpha",
    model: { input: ["text", "image"] },
  }, {
    id: "saved-row",
    sessionId: "private-saved-session",
    firstMessage: "Refine the mobile session drawer behavior",
    created: "2026-01-02T00:00:00.000Z",
    modified: "2026-01-02T01:00:00.000Z",
    sessionFile: "/fixture/saved-session.jsonl",
  }],
  snapshot: {
    state: {
      sessionId: "private-session",
      activeSessionId: "private-active",
      sessionName: "Live agent",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      goal: {
        active: true,
        status: "active",
        objective: "Ship the mobile shell",
        tokenBudget: 20_000,
        tokensUsed: 4_000,
        timeUsedSeconds: 120,
        continuationsUsed: 1,
      },
    },
    messages: [
      { id: "message-1", role: "assistant", content: "Ready", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        id: "message-2",
        role: "user",
        content: [{ type: "image", mimeType: "image/jpeg", data: FIXTURE_JPEG_DATA }],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ],
    children: [{
      id: "private-child-id",
      label: "Investigate every internal detail of the delegated task and report exact implementation notes",
      status: "running",
    }],
  },
  attachOptions: null,
  attachCount: 0,
  attachDelayMs: 0,
  snapshotDelayMs: 0,
  adapterDelayMs: 0,
  prompts: [],
  commands: [
    { name: "deploy", source: "extension", description: "private extension", sourceInfo: { path: "/private/extensions/deploy.ts" } },
    { name: "skill:review", source: "skill", sourceInfo: { path: "/private/skills/review.md" } },
    { name: "../../invalid", source: "prompt", sourceInfo: { path: "/private/prompts/invalid.md" } },
  ],
  availableModels: [
    { provider: "openai", id: "example", name: "Example", baseUrl: "https://private.invalid", headers: { Authorization: "secret" } },
    { provider: "other", id: "example", name: "Other Example" },
  ],
  connectionState: {
    sessionName: "Live agent",
    model: { provider: "openai", id: "example", name: "Example", headers: { Authorization: "secret" } },
    thinkingLevel: "medium",
    availableThinkingLevels: ["low", "medium", "high"],
  },
  sessionStats: {
    sessionFile: "/private/session.jsonl",
    sessionId: "private-session",
    tokens: { total: 12345 },
    cost: 1.25,
    contextUsage: { tokens: 5000, contextWindow: 100000, percent: 5 },
  },
  adapterCalls: [],
  aborts: 0,
  responses: [],
  creates: [],
  savedRenames: [],
  listener: null,
  listError: false,
  connectError: false,
  snapshotError: false,
  clientsCreated: 0,
  clientsClosed: 0,
  failClientsBelow: 0,
  listDelayMs: 0,
  listCalls: 0,
  activeListRequests: 0,
  maxConcurrentListRequests: 0,
  snapshotCalls: 0,
  activeSnapshotRequests: 0,
  maxConcurrentSnapshotRequests: 0,
  disposed: 0,
  responseDelayMs: 0,
};

const moduleSource = `
const state = globalThis.__primeWebFixture;
export class DaemonClient {
  constructor() { state.clientsCreated += 1; this.clientNumber = state.clientsCreated; }
  async connect() { if (state.connectError) throw new Error("private connect failure"); }
  async request(command) {
    if (this.clientNumber <= state.failClientsBelow) throw new Error("private dead client");
    if (command.type === "create") {
      state.creates.push(command);
      if (state.createError) return { success: false, error: state.createError };
      state.createdCount = (state.createdCount ?? 0) + 1;
      if (typeof command.sessionPath === "string") {
        const saved = state.sessions.find((session) => session.sessionFile === command.sessionPath);
        if (!saved) return { success: false, error: "saved session missing" };
        const activeSessionId = "private-resumed-active-" + state.createdCount;
        saved.activeSessionId = activeSessionId;
        return { success: true, data: { activeSessionId, sessionId: saved.sessionId } };
      }
      const sessionId = "private-created-session-" + state.createdCount;
      const activeSessionId = "private-created-active-" + state.createdCount;
      state.sessions.push({
        id: "created-row-" + state.createdCount,
        sessionId,
        activeSessionId,
        sessionName: command.name ?? null,
        firstMessage: "(no messages)",
      });
      return { success: true, data: { activeSessionId, sessionId } };
    }
    if (command.type === "rename_saved_session") {
      state.savedRenames.push(command);
      if (state.savedRenameError) return { success: false, error: state.savedRenameError };
      const saved = state.sessions.find((session) => session.sessionFile === command.sessionPath);
      if (!saved) return { success: false, error: "saved session missing" };
      saved.sessionName = command.name;
      return { success: true, data: {} };
    }
    if (command.type !== "list" || command.all !== true) return { success: false, error: "unexpected command" };
    state.listCalls += 1;
    state.activeListRequests += 1;
    state.maxConcurrentListRequests = Math.max(state.maxConcurrentListRequests, state.activeListRequests);
    const sessions = structuredClone(state.sessions);
    try {
      if (state.listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.listDelayMs));
      if (state.listError) throw new Error("private list failure");
      return { success: true, data: { sessions } };
    } finally {
      state.activeListRequests -= 1;
    }
  }
  close() { state.clientsClosed += 1; }
}
const connection = {
  subscribe(listener) { state.listener = listener; return () => { state.listener = null; }; },
  async getInitialSnapshot() {
    state.snapshotCalls += 1;
    if (state.snapshotError) throw new Error("private snapshot failure");
    state.activeSnapshotRequests += 1;
    state.maxConcurrentSnapshotRequests = Math.max(state.maxConcurrentSnapshotRequests, state.activeSnapshotRequests);
    const snapshot = structuredClone(state.snapshot);
    try {
      if (state.snapshotDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.snapshotDelayMs));
      return snapshot;
    } finally {
      state.activeSnapshotRequests -= 1;
    }
  },
  async getCommands() { return structuredClone(state.commands); },
  async getAvailableModels() { return structuredClone(state.availableModels); },
  async getState() { return structuredClone(state.connectionState); },
  async setModel(provider, modelId) {
    if (state.adapterDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.adapterDelayMs));
    state.adapterCalls.push({ method: "setModel", provider, modelId });
    const model = state.availableModels.find((item) => item.provider === provider && item.id === modelId);
    if (!model) throw new Error("private model error");
    state.connectionState.model = structuredClone(model);
    return structuredClone(model);
  },
  async setThinkingLevel(level) {
    state.adapterCalls.push({ method: "setThinkingLevel", level });
    state.connectionState.thinkingLevel = level;
  },
  async setSessionName(name) {
    state.adapterCalls.push({ method: "setSessionName", name });
    state.connectionState.sessionName = name;
    // The real daemon renames the session itself, so the next \`list\` reports
    // the new name. Without this the fixture would let a rename look applied
    // to the adapter while the catalog kept the old title.
    const attached = state.attachOptions && state.attachOptions.activeSessionId;
    const session = state.sessions.find((item) => item.activeSessionId === attached);
    if (session) session.sessionName = name;
  },
  async getSessionStats() { return structuredClone(state.sessionStats); },
  async getHeartbeat() { return state.heartbeat ? structuredClone(state.heartbeat) : undefined; },
  async setHeartbeat(schedule, instruction, deliveryMode) {
    state.adapterCalls.push({ method: "setHeartbeat", schedule, instruction, deliveryMode });
    state.heartbeat = {
      id: "private-heartbeat-id",
      cwd: "/private/project",
      prompt: instruction,
      status: "active",
      schedule: { expression: schedule },
      deliveryMode: deliveryMode ?? "steer",
      nextRunAt: "2026-01-02T00:00:00.000Z",
    };
    return structuredClone(state.heartbeat);
  },
  async updateHeartbeat(action) {
    state.adapterCalls.push({ method: "updateHeartbeat", action });
    if (!state.heartbeat) return undefined;
    if (action === "clear") { const previous = state.heartbeat; state.heartbeat = undefined; return structuredClone(previous); }
    state.heartbeat.status = action === "pause" ? "paused" : "active";
    return structuredClone(state.heartbeat);
  },
  async prompt(message, options) {
    if (state.promptError) throw state.promptError;
    state.prompts.push({ message, options });
  },
  async abort() { state.aborts += 1; },
  async respondToExtensionUiRequest(id, response) {
    if (state.responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.responseDelayMs));
    state.responses.push({ id, response });
  },
  async dispose() { state.disposed += 1; },
};
export const DaemonAgentConnection = {
  async attach(client, activeSessionId, options) {
    state.attachCount += 1;
    state.attachOptions = { activeSessionId, ...options };
    if (state.attachDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.attachDelayMs));
    return connection;
  },
};
export function defaultDaemonSocketPath() { return "/fixture/daemon.sock"; }
`;

function moduleSpecifier(): string {
  return `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}#${crypto.randomUUID()}`;
}

// The fixture daemon now mutates session rows the way a real one does — a
// rename changes what the next `list` reports — so the rows are restored
// between tests instead of being handed on half-renamed.
const pristineSessions = structuredClone(fixture.sessions);
const pristineConnectionState = structuredClone(fixture.connectionState);

afterEach(() => {
  fixture.sessions = structuredClone(pristineSessions);
  fixture.connectionState = structuredClone(pristineConnectionState);
  delete (globalThis as typeof globalThis & { __primeWebFixture?: FixtureState }).__primeWebFixture;
});

describe("projectPrimeTranscript", () => {
  it("projects rich thinking and python rows without forwarding daemon content duplicates", () => {
    const messages = projectPrimeTranscript([
      { role: "user", content: "Run the checks", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Initial notes\n\n**Inspecting the repository**" },
          { type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "print('details')" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "private tool output" }],
        timestamp: 3,
      },
      { role: "bashExecution", command: "npm run verify", output: "hidden command output", exitCode: 0, timestamp: 4 },
      { role: "custom", customType: "internal", display: false, content: "hidden notice", timestamp: 5 },
      { role: "custom", customType: "notice", display: true, content: "Visible notice", timestamp: 6 },
      { role: "assistant", content: [{ type: "text", text: "Checks passed" }], timestamp: 7 },
    ]);

    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({ role: "user", text: "Run the checks", state: "complete" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "Inspecting the repository",
      presentation: { kind: "thinking", full: "Initial notes\n\n**Inspecting the repository**" },
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      text: "print(…)",
      presentation: {
        kind: "python",
        lang: "python",
        status: "complete",
        preview: "print(…)",
        meta: "↑ 1 ↓ 1 lines",
        code: "print('details')",
        cellId: expect.stringMatching(/^cell_/),
      },
    });
    // The result carried only content blocks (daemon duplicates of details);
    // with no structured details, no output section is forwarded.
    expect(messages[2].presentation).not.toHaveProperty("stdout");
    expect(messages[3]).toMatchObject({
      role: "system",
      text: "npm verify",
      presentation: { kind: "tool", label: "bash", status: "complete", meta: "↑ 1 ↓ 1 lines" },
    });
    expect(messages[4]).toMatchObject({ role: "system", text: "Visible notice", state: "complete" });
    expect(messages[5]).toMatchObject({ role: "assistant", text: "Checks passed", state: "complete" });
    expect(JSON.stringify(messages)).not.toContain("private tool output");
    expect(JSON.stringify(messages)).not.toContain("hidden command output");
    expect(JSON.stringify(messages)).not.toContain("hidden notice");
  });

  it("keeps fallback IDs unique and content-stable for equal timestamps", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const source = [
      { role: "user", content: "first", timestamp },
      { role: "user", content: "second", timestamp },
      { role: "user", content: "first", timestamp },
    ];
    const projected = projectPrimeTranscript(source);
    expect(new Set(projected.map((message) => message.id)).size).toBe(3);

    expect(projectPrimeTranscript(source).map((message) => message.id))
      .toEqual(projected.map((message) => message.id));

    const streamingBefore = projectPrimeTranscript([], { role: "assistant", content: "Hel", timestamp })[0];
    const streamingAfter = projectPrimeTranscript([], { role: "assistant", content: "Hello", timestamp })[0];
    expect(streamingAfter?.id).toBe(streamingBefore?.id);
  });

  it("keeps branch and compaction summaries", () => {
    const messages = projectPrimeTranscript([
      { role: "compactionSummary", summary: "Earlier work was compacted", timestamp: 1 },
      { role: "branchSummary", summary: "Returned from an alternate branch", timestamp: 2 },
    ]);

    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "system", text: "Earlier work was compacted" },
      { role: "system", text: "Returned from an alternate branch" },
    ]);
  });

  it("shows a running one-line tool preview while its result is pending", () => {
    const messages = projectPrimeTranscript([], {
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "ipython", arguments: {} }],
      timestamp: 1,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "waiting for code",
      state: "streaming",
      presentation: { kind: "python", lang: "python", status: "running", preview: "waiting for code" },
    });
  });
  it("projects session commands as user rows and sanitizes failures", () => {
    const messages = projectPrimeTranscript([
      {
        role: "custom",
        customType: "session_slash_command",
        content: "/goal status",
        display: true,
        details: { command: { name: "goal", args: "status", text: "/goal status" } },
        timestamp: 1,
      },
      {
        role: "custom",
        customType: "session_slash_command_result",
        content: "Goal active: Ship it",
        display: true,
        details: { command: { name: "goal", args: "status", text: "/goal status" }, success: true },
        timestamp: 2,
      },
      {
        role: "custom",
        customType: "session_slash_command_result",
        content: "Command failed: private internal detail",
        display: true,
        details: { command: { name: "refine", args: "rollback invalid", text: "/refine rollback invalid" }, success: false },
        timestamp: 3,
      },
      {
        role: "custom",
        customType: "session_slash_command",
        content: "/goalEvil",
        display: true,
        details: { command: { name: "goal", args: "", text: "/goalEvil" } },
        timestamp: 4,
      },
    ]);

    expect(messages).toMatchObject([
      { role: "user", text: "/goal status", state: "complete" },
      { role: "system", text: "Goal active: Ship it", state: "complete" },
      { role: "system", text: "/refine failed.", state: "failed" },
      { role: "system", text: "/goalEvil", state: "complete" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("private internal detail");
  });

  it("emits an error row for a failed turn instead of zero rows", () => {
    const messages = projectPrimeTranscript([
      { role: "user", content: "Do the thing", timestamp: 1 },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provider exploded at /Users/private-person/repo",
        timestamp: 2,
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      state: "failed",
      presentation: { kind: "error", label: "Turn failed" },
      turnId: messages[0].id,
    });
    expect(messages[1].text).toContain("Provider exploded");
    expect(messages[1].text).not.toContain("/Users/");

    const withoutDetail = projectPrimeTranscript([
      { role: "assistant", content: [], stopReason: "error", timestamp: 3 },
    ]);
    expect(withoutDetail[0]).toMatchObject({ text: "The response failed.", state: "failed" });

    // A still-streaming failed candidate stays quiet until the turn settles.
    const streaming = projectPrimeTranscript([], {
      role: "assistant", content: [], stopReason: "error", errorMessage: "x", timestamp: 4,
    });
    expect(streaming.filter((row) => row.presentation?.kind === "error")).toHaveLength(0);
  });

  it("assigns turn ids at user prompts and session commands, inherited by streaming rows", () => {
    const messages = projectPrimeTranscript([
      { role: "system", content: "Welcome", timestamp: 1 },
      { role: "user", content: "First ask", timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "Answer" }], timestamp: 3 },
      {
        role: "custom",
        customType: "session_slash_command",
        content: "/refine",
        display: true,
        details: { command: { name: "refine", text: "/refine" } },
        timestamp: 4,
      },
      {
        role: "custom",
        customType: "session_slash_command_result",
        content: "Refined continual harness state: 1 edit applied.",
        display: true,
        details: { command: { name: "refine", text: "/refine" }, success: true },
        timestamp: 5,
      },
    ], { role: "assistant", content: "Streaming reply", timestamp: 6 });

    expect(messages).toHaveLength(6);
    expect(messages[0].turnId).toBeUndefined();
    expect(messages[1].turnId).toBe(messages[1].id);
    expect(messages[2].turnId).toBe(messages[1].id);
    expect(messages[3]).toMatchObject({ role: "user", text: "/refine" });
    expect(messages[3].turnId).toBe(messages[3].id);
    expect(messages[4].turnId).toBe(messages[3].id);
    expect(messages[5]).toMatchObject({ state: "streaming", turnId: messages[3].id });
  });

  it("counts presentation bytes into the transcript budget", () => {
    const code = "x".repeat(15_000);
    const source = Array.from({ length: 150 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "toolCall", id: `budget-${index}`, name: "ipython", arguments: { code } }],
      timestamp: index + 1,
    }));
    const messages = projectPrimeTranscript(source);
    // 150 rows of tiny preview text but ~15KB presentations must overflow the
    // 2MiB budget; a text-only count would keep every row.
    expect(messages.length).toBeLessThan(150);
    expect(messages.length).toBeGreaterThan(100);
    expect(messages.at(-1)?.presentation).toMatchObject({ kind: "python", code });
  });
});

describe("PrimeBackend", () => {
  it("uses the public daemon adapter and validates browser approval choices", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.attachOptions = null;
    fixture.attachCount = 0;
    fixture.attachDelayMs = 0;
    fixture.snapshotDelayMs = 20;
    fixture.adapterDelayMs = 0;
    fixture.prompts = [];
    fixture.aborts = 0;
    fixture.responses = [];
    fixture.adapterCalls = [];
    fixture.heartbeat = undefined;
    fixture.connectionState = {
      sessionName: "Live agent",
      model: { provider: "openai", id: "example", name: "Example", headers: { Authorization: "secret" } },
      thinkingLevel: "medium",
      availableThinkingLevels: ["low", "medium", "high"],
    };
    fixture.listener = null;

    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const summary = backend.catalog().agents[0];
      expect(summary.id).toMatch(/^agent_/);
      expect(summary.id).not.toContain("private-session");
      expect(summary).toMatchObject({
        activity: "working",
        attention: null,
        unreadCount: 0,
        cwd: "/projects/alpha",
        capabilities: { images: true },
      });
      expect(backend.catalog().agents.find((agent) => agent.id !== summary.id)?.name)
        .toBe("Refine the mobile session drawer behavior");

      const [initialSnapshot, initialCommandCatalog] = await Promise.all([
        backend.agentSnapshot(summary.id),
        backend.slashCommandCatalog(summary.id),
      ]);
      fixture.snapshotDelayMs = 0;
      expect(fixture.attachCount).toBe(1);
      // Context stats land asynchronously right after the first projection and
      // advance the revision; settle before capturing the mutation baseline.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const snapshot = await backend.agentSnapshot(summary.id);
      expect(snapshot?.messages).toEqual(initialSnapshot?.messages);
      expect(snapshot?.messages[0].text).toBe("Ready");
      expect(snapshot?.messages[1]).toMatchObject({
        role: "user",
        text: "",
        attachments: [{ id: expect.stringMatching(/^image_/), type: "image", mimeType: "image/jpeg" }],
      });
      expect(JSON.stringify(snapshot)).not.toContain("/9j/");
      expect(JSON.stringify(snapshot)).not.toContain("private-child-id");
      expect(snapshot?.dashboard).toMatchObject({ status: "idle", needsInput: true });
      expect(snapshot?.dashboard?.contextUsage).toEqual({ tokens: 5_000, contextWindow: 100_000, percent: 5 });
      expect(snapshot?.dashboard?.children).toHaveLength(1);
      expect(snapshot?.dashboard?.children[0]).toMatchObject({
        id: expect.not.stringContaining("private-child-id"),
        name: expect.stringContaining("Investigate every internal detail"),
        status: "running",
      });
      const attachmentId = snapshot?.messages[1].attachments?.[0]?.id;
      expect(attachmentId && backend.attachment(attachmentId)?.bytes.byteLength).toBe(28);
      expect(snapshot?.goal).toMatchObject({
        status: "active",
        objective: "Ship the mobile shell",
        tokenBudget: 20_000,
        tokensUsed: 4_000,
      });
      expect(fixture.attachOptions).toMatchObject({
        activeSessionId: "private-active",
        closeClientOnDispose: false,
        supportsExtensionUi: true,
      });

      await backend.sendMessage({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        text: "Hello",
        images: [],
      });
      expect(fixture.prompts).toEqual([{ message: "Hello", options: { queueIfBusy: true, streamingBehavior: "steer", images: [] } }]);

      await backend.sendMessage({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        text: "",
        images: validateImageAttachments([{
          type: "image",
          mimeType: "image/jpeg",
          data: FIXTURE_JPEG_DATA,
        }]),
      });
      expect(fixture.prompts[1]).toEqual({
        message: "Image attached.",
        options: {
          queueIfBusy: true,
          streamingBehavior: "steer",
          images: [{ type: "image", mimeType: "image/jpeg", data: FIXTURE_JPEG_DATA }],
        },
      });

      await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        name: "goal",
        args: "status",
      });
      expect(fixture.prompts[2]).toEqual({
        message: "/goal status",
        options: { queueIfBusy: true, streamingBehavior: "steer" },
      });
      await expect(backend.sendMessage({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        text: "/model gpt",
        images: [],
      })).rejects.toBeInstanceOf(BackendCapabilityError);
      expect(fixture.prompts).toHaveLength(3);

      const commandCatalog = initialCommandCatalog;
      expect(commandCatalog?.commands.filter((command) => command.availability === "available").map((command) => command.name))
        .toEqual(["compact", "refine", "goal", "autonomous", "model", "effort", "name", "context", "heartbeat"]);
      expect(commandCatalog?.commands.filter((command) => command.availability === "experimental").map((command) => command.name))
        .toEqual(["deploy", "skill:review"]);
      expect(JSON.stringify(commandCatalog)).not.toContain("/private/");
      expect(JSON.stringify(commandCatalog)).not.toContain("Authorization");
      expect(JSON.stringify(commandCatalog)).not.toContain("baseUrl");

      const experimentalResult = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        name: "deploy",
        args: "staging",
      });
      expect(experimentalResult.result).toEqual({ kind: "experimental_accepted", source: "extension" });
      expect(fixture.prompts[3]).toEqual({
        message: "/deploy staging",
        options: { queueIfBusy: true, streamingBehavior: "steer" },
      });
      await expect(backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        name: "settings",
        args: "",
      })).rejects.toBeInstanceOf(BackendCapabilityError);
      expect(fixture.prompts).toHaveLength(4);

      await expect(backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        name: "model",
        args: "example",
      })).rejects.toBeInstanceOf(BackendCapabilityError);
      const modelResult = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        name: "model",
        args: "openai/example",
      });
      expect(modelResult.result).toEqual({ kind: "model", provider: "openai", modelId: "example" });

      const effortResult = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: modelResult.revision,
        name: "effort",
        args: "high",
      });
      expect(effortResult.result).toEqual({ kind: "effort", level: "high", availableLevels: ["low", "medium", "high"] });

      const nameResult = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: effortResult.revision,
        name: "name",
        args: "Renamed safely",
      });
      expect(nameResult.result).toEqual({ kind: "name", name: "Renamed safely" });

      const contextResult = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: nameResult.revision,
        name: "context",
        args: "",
      });
      expect(contextResult.result).toEqual({
        kind: "context_usage",
        contextTokens: 5_000,
        contextWindow: 100_000,
        percent: 5,
        totalTokens: 12_345,
        cost: 1.25,
      });
      expect(JSON.stringify(contextResult)).not.toContain("private-session");
      expect(JSON.stringify(contextResult)).not.toContain("session.jsonl");

      const heartbeatResult = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: contextResult.revision,
        name: "heartbeat",
        args: "every 15m --follow-up private instruction",
      });
      expect(heartbeatResult.result).toEqual({
        kind: "heartbeat",
        status: "active",
        schedule: "every 15m",
        deliveryMode: "follow_up",
        nextRunAt: "2026-01-02T00:00:00.000Z",
      });
      expect(JSON.stringify(heartbeatResult)).not.toContain("private instruction");
      expect(JSON.stringify(heartbeatResult)).not.toContain("private-heartbeat-id");
      const clearedHeartbeat = await backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: heartbeatResult.revision,
        name: "heartbeat",
        args: "clear",
      });
      expect(clearedHeartbeat.result).toEqual({ kind: "heartbeat", status: "none" });
      expect(fixture.adapterCalls.map((call) => call.method)).toEqual([
        "setModel", "setThinkingLevel", "setSessionName", "setHeartbeat", "updateHeartbeat",
      ]);
      expect(fixture.prompts).toHaveLength(4);

      fixture.promptError = new Error("provider detail with sensitive image payload");
      let promptError: unknown;
      try {
        await backend.sendMessage({
          agentId: summary.id,
          requestId: crypto.randomUUID(),
          expectedRevision: clearedHeartbeat.revision,
          text: "sensitive prompt text",
          images: [],
        });
      } catch (error) {
        promptError = error;
      }
      expect(promptError).toBeInstanceOf(Error);
      expect((promptError as Error).message).toBe("Prime prompt failed");
      expect(JSON.stringify(promptError)).not.toContain("sensitive");

      let commandError: unknown;
      try {
        await backend.executeSlashCommand({
          agentId: summary.id,
          requestId: crypto.randomUUID(),
          expectedRevision: clearedHeartbeat.revision,
          name: "refine",
          args: "private command argument",
        });
      } catch (error) {
        commandError = error;
      }
      expect(commandError).toBeInstanceOf(Error);
      expect((commandError as Error).message).toBe("Prime command failed");
      expect(JSON.stringify(commandError)).not.toContain("private command argument");
      delete fixture.promptError;

      const listener = Reflect.get(fixture, "listener") as ((event: unknown) => void) | null;
      expect(listener).not.toBeNull();
      listener!({
        type: "extension_ui_request",
        request: { id: "status-1", method: "notify", payload: { message: "FYI" } },
      });
      listener!({
        type: "extension_ui_request",
        request: { id: "input-1", method: "input", payload: { title: "Unsupported text input" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect((await backend.agentSnapshot(summary.id))?.attention).toEqual([]);
      expect(backend.catalog().agents[0].attention).toBeNull();
      expect(fixture.responses).toEqual([{ id: "input-1", response: { cancelled: true } }]);

      listener!({
        type: "extension_ui_request",
        request: { id: "request-1", method: "confirm", payload: { title: "Approve?", message: "Review this action" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      const withAttention = await backend.agentSnapshot(summary.id);
      expect(withAttention?.attention[0]).toMatchObject({ id: "request-1", kind: "dialog", title: "Approve?" });
      expect(withAttention?.attention[0].options.map((option) => option.label)).toEqual(["Decline", "Confirm"]);
      expect(backend.catalog().agents[0].attention).toBe("dialog");

      await expect(backend.resolveAttention({
        attentionId: "request-1",
        requestId: crypto.randomUUID(),
        expectedRevision: withAttention!.attention[0].revision,
        optionId: "invented-option",
      })).rejects.toBeInstanceOf(BackendCapabilityError);
      expect(fixture.responses).toHaveLength(1);

      await backend.resolveAttention({
        attentionId: "request-1",
        requestId: crypto.randomUUID(),
        expectedRevision: withAttention!.attention[0].revision,
        optionId: "confirm",
      });
      expect(fixture.responses).toEqual([
        { id: "input-1", response: { cancelled: true } },
        { id: "request-1", response: { confirmed: true } },
      ]);
      expect(backend.catalog().agents[0].attention).toBeNull();

      const latest = await backend.agentSnapshot(summary.id);
      await backend.abort({ agentId: summary.id, requestId: crypto.randomUUID(), expectedRevision: latest!.revision });
      expect(fixture.aborts).toBe(1);
    } finally {
      hub.close();
      await backend.close();
    }
  });

  it("serializes direct adapter mutations and rejects stale overlapping commands", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    delete fixture.promptError;
    fixture.adapterCalls = [];
    fixture.attachDelayMs = 0;
    fixture.snapshotDelayMs = 0;
    fixture.adapterDelayMs = 20;
    fixture.connectionState = {
      sessionName: "Live agent",
      model: { provider: "openai", id: "example" },
      thinkingLevel: "medium",
      availableThinkingLevels: ["low", "medium", "high"],
    };
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const summary = backend.catalog().agents[0];
      await backend.agentSnapshot(summary.id);
      // Let the async context-stats revision bump land before capturing revisions.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const snapshot = await backend.agentSnapshot(summary.id);
      const execute = () => backend.executeSlashCommand({
        agentId: summary.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        name: "model",
        args: "openai/example",
      });
      const results = await Promise.allSettled([execute(), execute()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(BackendConflictError) });
      expect(fixture.adapterCalls.filter((call) => call.method === "setModel")).toHaveLength(1);
      expect((await backend.agentSnapshot(summary.id))?.revision).toBe(snapshot!.revision + 1);
    } finally {
      fixture.adapterDelayMs = 0;
      hub.close();
      await backend.close();
    }
  });

  it("hides empty drafts and requires real activity before showing working state", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = [
      ...originalSessions,
      { id: "stub-row", sessionId: "private-stub-session", firstMessage: "(no messages)", activity: "working" },
      {
        id: "draft-row",
        sessionId: "private-draft-session",
        activeSessionId: "private-draft-active",
        lifecycle: "draft",
        activity: "working",
        firstMessage: "(no messages)",
      },
      {
        id: "named-draft-row",
        sessionId: "private-named-draft-session",
        activeSessionId: "private-named-draft-active",
        sessionName: "Fresh draft",
        lifecycle: "draft",
        activity: "working",
      },
      { id: "idle-row", sessionId: "private-idle-session", sessionName: "Idle but marked working", activity: "working" },
    ];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agents = backend.catalog().agents;
      expect(agents.find((agent) => agent.name === "Untitled session")).toBeUndefined();
      const draft = agents.find((agent) => agent.name === "Fresh draft");
      expect(draft).toMatchObject({ lifecycle: "starting", activity: "idle" });
      expect(draft?.capabilities.abort).toBe(false);
      const idle = agents.find((agent) => agent.name === "Idle but marked working");
      expect(idle?.activity).toBe("idle");
      expect(agents.find((agent) => agent.name === "Live agent")?.activity).toBe("working");
    } finally {
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  it("wakes an inactive saved session when sending and replaces its subscribed snapshot", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = originalSessions.map((session) => ({ ...session }));
    fixture.creates = [];
    fixture.prompts = [];
    fixture.attachCount = 0;
    fixture.attachOptions = null;
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const inactive = backend.catalog().agents.find((agent) => agent.lifecycle === "inactive");
      expect(inactive?.capabilities).toMatchObject({ send: false, resume: true });
      const snapshot = await backend.agentSnapshot(inactive!.id);
      const frames: unknown[] = [];
      const subscription = hub.attach(`agent:${inactive!.id}`, null, (frame) => frames.push(frame));
      expect(subscription).not.toBeNull();

      const result = await backend.sendMessage({
        agentId: inactive!.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        text: "Continue this thread",
        images: [],
      });

      expect(fixture.creates).toEqual([{ type: "create", sessionPath: "/fixture/saved-session.jsonl" }]);
      expect(fixture.prompts).toEqual([{
        message: "Continue this thread",
        options: { queueIfBusy: true, streamingBehavior: "steer", images: [] },
      }]);
      expect(fixture.attachOptions).toMatchObject({
        activeSessionId: expect.stringMatching(/^private-resumed-active-/),
        closeClientOnDispose: false,
        supportsExtensionUi: true,
      });
      expect(result.revision).toBeGreaterThan(snapshot!.revision);
      expect(backend.catalog().agents.find((agent) => agent.id === inactive!.id)).toMatchObject({
        lifecycle: "live",
        capabilities: { send: true, resume: false },
      });
      expect(frames).toContainEqual(expect.objectContaining({
        type: "event",
        envelope: expect.objectContaining({
          event: expect.objectContaining({ kind: "agent.replaced" }),
        }),
      }));
      expect(hub.getSnapshot(`agent:${inactive!.id}`)).toMatchObject({ agentId: inactive!.id, revision: result.revision });
      subscription?.detach();

      await expect(backend.sendMessage({
        agentId: inactive!.id,
        requestId: crypto.randomUUID(),
        expectedRevision: snapshot!.revision,
        text: "A stale retry",
        images: [],
      })).rejects.toBeInstanceOf(BackendConflictError);
      expect(fixture.creates).toHaveLength(1);
      expect(fixture.prompts).toHaveLength(1);
    } finally {
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  it("renames a live session through the adapter and a saved one through its file", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = originalSessions.map((session) => ({ ...session }));
    fixture.adapterCalls = [];
    fixture.savedRenames = [];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const live = backend.catalog().agents.find((agent) => agent.lifecycle === "live");
      const saved = backend.catalog().agents.find((agent) => agent.lifecycle === "inactive");
      // Both are renameable, by different routes; neither bit is probed.
      expect(live?.capabilities.rename).toBe(true);
      expect(saved?.capabilities.rename).toBe(true);

      // The first read attaches the connection, which advances the revision;
      // the second is the one a client would actually be holding.
      await backend.agentSnapshot(live!.id);
      const liveSnapshot = await backend.agentSnapshot(live!.id);
      const renamedLive = await backend.rename({
        agentId: live!.id,
        requestId: crypto.randomUUID(),
        expectedRevision: liveSnapshot!.revision,
        name: "Renamed live session",
      });
      expect(fixture.adapterCalls).toContainEqual({ method: "setSessionName", name: "Renamed live session" });
      expect(fixture.savedRenames).toHaveLength(0);
      expect(renamedLive.revision).toBeGreaterThan(liveSnapshot!.revision);
      expect(backend.catalog().agents.find((agent) => agent.id === live!.id)?.name).toBe("Renamed live session");

      // A stale revision is a conflict, not a second rename.
      await expect(backend.rename({
        agentId: live!.id,
        requestId: crypto.randomUUID(),
        expectedRevision: liveSnapshot!.revision,
        name: "Should not land",
      })).rejects.toBeInstanceOf(BackendConflictError);
      expect(fixture.adapterCalls.filter((call) => call.method === "setSessionName")).toHaveLength(1);

      const savedSnapshot = await backend.agentSnapshot(saved!.id);
      const renamedSaved = await backend.rename({
        agentId: saved!.id,
        requestId: crypto.randomUUID(),
        expectedRevision: savedSnapshot!.revision,
        name: "Renamed saved session",
      });
      // The path is the daemon's own, taken from its listing — never the caller's.
      expect(fixture.savedRenames).toEqual([{
        type: "rename_saved_session",
        sessionPath: "/fixture/saved-session.jsonl",
        name: "Renamed saved session",
      }]);
      expect(renamedSaved.revision).toBeGreaterThan(savedSnapshot!.revision);
      expect(backend.catalog().agents.find((agent) => agent.id === saved!.id)?.name).toBe("Renamed saved session");

      // A daemon that refuses must not read as success.
      fixture.savedRenameError = "private rename failure";
      await expect(backend.rename({
        agentId: saved!.id,
        requestId: crypto.randomUUID(),
        expectedRevision: renamedSaved.revision,
        name: "Never applied",
      })).rejects.toThrow("Prime session rename failed");
    } finally {
      delete fixture.savedRenameError;
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  it("creates sessions through the daemon and resolves the new agent id", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = [...originalSessions];
    fixture.creates = [];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      await expect(backend.createSession({ requestId: crypto.randomUUID(), cwd: "relative/path" }))
        .rejects.toBeInstanceOf(BackendCapabilityError);

      const result = await backend.createSession({
        requestId: crypto.randomUUID(),
        cwd: "/projects/new-thing",
        name: "Fresh start",
      });
      expect(fixture.creates).toEqual([{ type: "create", name: "Fresh start", config: { cwd: "/projects/new-thing" } }]);
      expect(result.agentId).toMatch(/^agent_/);
      const created = backend.catalog().agents.find((agent) => agent.id === result.agentId);
      expect(created).toBeDefined();
      expect(created?.name).toBe("Fresh start");
      expect(created?.capabilities.send).toBe(true);

      // The event stream must exist immediately so a client attach after
      // creation succeeds instead of bouncing with stream_gone.
      expect(hub.has(`agent:${result.agentId}`)).toBe(true);

      const second = await backend.createSession({
        requestId: crypto.randomUUID(),
        cwd: "/projects/new-thing",
        name: "Fresh start",
      });
      expect(fixture.creates[1]).toMatchObject({ name: "Fresh start 2", config: { cwd: "/projects/new-thing" } });
      expect(second.agentId).not.toBe(result.agentId);
    } finally {
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  it("projects compact thinking and tool rows from an inactive saved session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-mobile-session-"));
    const sessionFile = join(directory, "session.jsonl");
    try {
      const savedImageBytes = Buffer.alloc(900 * 1024);
      Buffer.from(FIXTURE_JPEG_DATA, "base64").copy(savedImageBytes);
      savedImageBytes.set([0xff, 0xd9], savedImageBytes.length - 2);
      const savedImageData = savedImageBytes.toString("base64");
      expect(savedImageData.length).toBeGreaterThan(1024 * 1024);
      const entries = [
        { type: "session", id: "private-session-header", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" },
        {
          type: "message",
          id: "private-user-entry",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Inspect the drawer" }] },
        },
        {
          type: "message",
          id: "private-work-entry",
          timestamp: "2026-01-01T00:02:00.000Z",
          message: { role: "assistant", content: [
            { type: "thinking", thinking: "**Checking overflow behavior**" },
            { type: "toolCall", id: "private-tool-call", name: "ipython", arguments: { code: "print('drawer')" } },
          ] },
        },
        {
          type: "message",
          id: "private-tool-entry",
          timestamp: "2026-01-01T00:03:00.000Z",
          message: {
            role: "toolResult",
            toolCallId: "private-tool-call",
            content: [{ type: "text", text: "private tool output" }],
            details: { status: "ok", durationMs: 12, stdout: "private tool output" },
          },
        },
        {
          type: "branch_summary",
          id: "private-branch-entry",
          timestamp: "2026-01-01T00:03:30.000Z",
          summary: "Exploration branch was summarized.",
        },
        {
          type: "compaction",
          id: "private-compaction-entry",
          timestamp: "2026-01-01T00:03:40.000Z",
          summary: "Earlier context was compacted.",
        },
        {
          type: "message",
          id: "private-image-entry",
          timestamp: "2026-01-01T00:03:50.000Z",
          message: {
            role: "user",
            content: [{ type: "image", mimeType: "image/jpeg", data: savedImageData }],
          },
        },
        {
          type: "message",
          id: "private-assistant-entry",
          timestamp: "2026-01-01T00:04:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "The drawer needs an overflow lock." }] },
        },
      ];
      await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

      const messages = await projectSavedSessionTranscript(sessionFile);
      expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Inspect the drawer" },
        { role: "assistant", text: "Checking overflow behavior" },
        { role: "assistant", text: "print(…)" },
        { role: "system", text: "Exploration branch was summarized." },
        { role: "system", text: "Earlier context was compacted." },
        { role: "user", text: "" },
        { role: "assistant", text: "The drawer needs an overflow lock." },
      ]);
      expect(messages[2].presentation).toEqual({
        kind: "python",
        lang: "python",
        status: "complete",
        preview: "print(…)",
        meta: "↑ 1 ↓ 1 lines · 12ms",
        code: "print('drawer')",
        // Output panels ship verbatim-but-bounded from details (D2/D3).
        stdout: "private tool output",
        durationMs: 12,
        cellId: expect.stringMatching(/^cell_/),
      });
      expect(messages[5].attachments).toEqual([
        { id: expect.stringMatching(/^image_/), type: "image", mimeType: "image/jpeg" },
      ]);
      expect(JSON.stringify(messages)).not.toContain(savedImageData);
      expect(messages.every((message) => !message.id.includes("private"))).toBe(true);
      const liveSource: unknown[] = [];
      for (const entry of entries) {
        if (entry.type === "message") liveSource.push({ ...entry.message, timestamp: entry.timestamp });
        else if (entry.type === "branch_summary") liveSource.push({ role: "branchSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) });
        else if (entry.type === "compaction") liveSource.push({ role: "compactionSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) });
      }
      const liveMessages = projectPrimeTranscript(liveSource);
      expect(messages.map((message) => message.id)).toEqual(liveMessages.map((message) => message.id));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks saved tools unknown when an oversized result envelope is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-mobile-session-"));
    const sessionFile = join(directory, "session.jsonl");
    try {
      const call = {
        type: "message",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "toolCall", id: "oversized-tool", name: "ipython", arguments: { code: "run_check()" } }],
        },
      };
      const result = {
        type: "message",
        timestamp: "2026-01-01T00:02:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "oversized-tool",
          content: [{ type: "text", text: "x".repeat(MAX_IMAGE_REQUEST_BASE64_CHARS + 1024 * 1024 + 100) }],
        },
      };
      await writeFile(sessionFile, `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`);

      const messages = await projectSavedSessionTranscript(sessionFile);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        text: "run_check()",
        state: "complete",
        presentation: { kind: "python", status: "unknown", code: "run_check()" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


  it("serializes dirty catalog refreshes and applies the newest list", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = originalSessions.map((session) => structuredClone(session));
    fixture.listError = false;
    fixture.listDelayMs = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      fixture.listCalls = 0;
      fixture.activeListRequests = 0;
      fixture.maxConcurrentListRequests = 0;
      fixture.listDelayMs = 25;
      const frames: ServerFrame[] = [];
      const attached = hub.attach("catalog", null, (frame) => frames.push(frame));
      const refresh = () => Reflect.get(backend, "refreshCatalog").call(backend, true) as Promise<void>;
      const first = refresh();
      const second = refresh();
      fixture.sessions[0].sessionName = "Newest catalog name";
      await Promise.all([first, second]);

      expect(fixture.listCalls).toBe(2);
      expect(fixture.maxConcurrentListRequests).toBe(1);
      expect(backend.catalog().agents[0].name).toBe("Newest catalog name");
      const catalogEvents = frames.filter((frame) =>
        frame.type === "event" && frame.envelope.event.kind === "catalog.replaced");
      expect(catalogEvents).toHaveLength(1);
      expect(catalogEvents[0]).toMatchObject({
        type: "event",
        envelope: {
          event: {
            payload: { agents: expect.arrayContaining([expect.objectContaining({ name: "Newest catalog name" })]) },
          },
        },
      });
      attached?.detach();
    } finally {
      fixture.listDelayMs = 0;
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  it("refreshes during sustained event traffic without overlapping snapshots", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.listDelayMs = 0;
    fixture.snapshotDelayMs = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      fixture.snapshotCalls = 0;
      fixture.activeSnapshotRequests = 0;
      fixture.maxConcurrentSnapshotRequests = 0;
      fixture.snapshotDelayMs = 30;
      const listener = Reflect.get(fixture, "listener") as ((event: unknown) => void);
      for (let index = 0; index < 10; index += 1) {
        listener({ type: "streaming_update", index });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fixture.snapshotCalls).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(fixture.maxConcurrentSnapshotRequests).toBe(1);
      expect(fixture.snapshotCalls).toBeGreaterThanOrEqual(2);
    } finally {
      fixture.snapshotDelayMs = 0;
      hub.close();
      await backend.close();
    }
  });

  it("disposes a connection whose active session changes", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = originalSessions.map((session) => structuredClone(session));
    fixture.listError = false;
    fixture.listDelayMs = 0;
    fixture.snapshotDelayMs = 0;
    fixture.disposed = 0;
    fixture.attachCount = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      fixture.sessions[0].activeSessionId = "private-active-replaced";
      await (Reflect.get(backend, "refreshCatalog").call(backend, true) as Promise<void>);
      expect(fixture.disposed).toBe(1);

      await backend.agentSnapshot(agentId);
      expect(fixture.attachCount).toBe(2);
      expect(fixture.attachOptions).toMatchObject({ activeSessionId: "private-active-replaced" });
    } finally {
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  // The event `agent.attention_added` is only published when a client is
  // attached to that agent's stream, which is never true in the case push
  // exists for: phone locked, app closed, nothing watching. So the listener
  // has to fire independently of the hub.
  it("notifies attention listeners even when nothing is attached to the agent stream", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.snapshotDelayMs = 0;
    fixture.responses = [];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    const seen: AttentionRequest[] = [];
    backend.onAttentionAdded((attention) => seen.push(attention));
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      hub.unregister(`agent:${agentId}`);
      expect(hub.has(`agent:${agentId}`)).toBe(false);

      const listener = Reflect.get(fixture, "listener") as ((event: unknown) => void);
      listener({
        type: "extension_ui_request",
        request: { id: "app-was-closed", method: "confirm", payload: { title: "Approve?" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: "app-was-closed", agentId, kind: "dialog" });
    } finally {
      hub.close();
      await backend.close();
    }
  });

  it("claims an attention response once before awaiting the adapter", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.snapshotDelayMs = 0;
    fixture.responseDelayMs = 30;
    fixture.responses = [];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      const listener = Reflect.get(fixture, "listener") as ((event: unknown) => void);
      listener({
        type: "extension_ui_request",
        request: { id: "atomic-request", method: "confirm", payload: { title: "Approve?" } },
      });
      const attentionCatalogRevision = backend.catalog().revision;
      await (Reflect.get(backend, "refreshCatalog").call(backend, true) as Promise<void>);
      expect(backend.catalog().revision).toBe(attentionCatalogRevision);
      const request = (await backend.agentSnapshot(agentId))!.attention[0];
      const resolve = () => backend.resolveAttention({
        attentionId: request.id,
        requestId: crypto.randomUUID(),
        expectedRevision: request.revision,
        optionId: "confirm",
      });
      const results = await Promise.allSettled([resolve(), resolve()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fixture.responses).toHaveLength(1);
      expect((await backend.agentSnapshot(agentId))?.attention).toEqual([]);
    } finally {
      fixture.responseDelayMs = 0;
      hub.close();
      await backend.close();
    }
  });

  it("sanitizes daemon create failures", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.createError = "private daemon create detail";
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      await expect(backend.createSession({ requestId: crypto.randomUUID(), cwd: "/projects/new" }))
        .rejects.toThrow("The daemon could not create the session");
    } finally {
      delete fixture.createError;
      hub.close();
      await backend.close();
    }
  });

  it("handles a rejected close-event catalog refresh without an unhandled rejection", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.snapshotDelayMs = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      fixture.listError = true;
      const listener = Reflect.get(fixture, "listener") as ((event: unknown) => void);
      listener({ type: "closed" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(error).toHaveBeenCalledWith("Prime catalog refresh failed after connection close");
    } finally {
      fixture.listError = false;
      error.mockRestore();
      hub.close();
      await backend.close();
    }
  });

  it("skips malformed saved rows and keeps missing timestamps stable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-mobile-malformed-"));
    const sessionFile = join(directory, "session.jsonl");
    try {
      await writeFile(sessionFile, [
        "null",
        "[]",
        "{not-json",
        JSON.stringify({ type: "message", message: { role: "user", content: "kept" } }),
        JSON.stringify({ type: "message", message: null }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "also kept" } }),
      ].join("\n"));
      const first = await projectSavedSessionTranscript(sessionFile);
      const second = await projectSavedSessionTranscript(sessionFile);
      expect(first.map((message) => message.text)).toEqual(["kept", "also kept"]);
      expect(second.map((message) => message.createdAt)).toEqual(first.map((message) => message.createdAt));
      expect(first.map((message) => message.createdAt)).toEqual([
        "1970-01-01T00:00:00.000Z",
        "1970-01-01T00:00:00.000Z",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


  it("validates and bounds daemon summaries and snapshots", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    const originalSnapshot = fixture.snapshot;
    fixture.listError = false;
    fixture.sessions = [
      {} as Record<string, unknown>,
      {
        id: "bounded-row",
        sessionId: "bounded-session",
        activeSessionId: "bounded-active",
        sessionName: "n".repeat(1_000),
        summary: "s".repeat(10_000),
        cwd: "/" + "c".repeat(10_000),
        created: "not-a-date",
        modified: 9e99,
        model: { input: ["image", 1, "x".repeat(100)] },
      },
    ];
    fixture.snapshot = {
      state: {
        sessionId: "bounded-session",
        activeSessionId: "bounded-active",
        isStreaming: "yes",
        isCompacting: false,
        isBashRunning: false,
        recap: "r".repeat(10_000),
      },
      messages: Array.from({ length: 1_100 }, (_, index) => ({ role: "user", content: `message-${index}` })),
      children: Array.from({ length: 300 }, (_, index) => ({ id: `child-${index}`, label: "l".repeat(500), status: "running" })),
    };
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      expect(backend.catalog().agents).toHaveLength(1);
      expect(backend.catalog().agents[0]).toMatchObject({
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        activity: "idle",
        capabilities: { images: true },
      });
      expect(backend.catalog().agents[0].name.length).toBeLessThanOrEqual(80);
      expect(backend.catalog().agents[0].cwd?.length).toBe(2_048);
      const snapshot = await backend.agentSnapshot(backend.catalog().agents[0].id);
      expect(snapshot?.messages).toHaveLength(1_000);
      expect(snapshot?.messages[0].createdAt).toBe("1970-01-01T00:00:00.000Z");
      expect(snapshot?.dashboard).toMatchObject({ status: "idle", needsInput: false, recap: "r".repeat(4_000) });
      expect(snapshot?.dashboard?.children).toHaveLength(250);
      expect(snapshot?.dashboard?.children.every((child) =>
        child.name.length <= 80 && child.status === "running")).toBe(true);
    } finally {
      fixture.sessions = originalSessions;
      fixture.snapshot = originalSnapshot;
      hub.close();
      await backend.close();
    }
  });


  it("bounds catalog drain batches without overlapping or abandoning waiters", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.listDelayMs = 15;
    fixture.listCalls = 0;
    fixture.activeListRequests = 0;
    fixture.maxConcurrentListRequests = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      fixture.listCalls = 0;
      const refresh = () => Reflect.get(backend, "refreshCatalog").call(backend, true) as Promise<void>;
      const waiters: Promise<void>[] = [];
      for (let index = 0; index < 12; index += 1) {
        waiters.push(refresh());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await Promise.all(waiters);
      expect(fixture.maxConcurrentListRequests).toBe(1);
      expect(fixture.listCalls).toBeGreaterThan(1);
      expect(Reflect.get(Reflect.get(backend, "catalogQueue") as object, "waiters")).toHaveLength(0);
    } finally {
      fixture.listDelayMs = 0;
      hub.close();
      await backend.close();
    }
  });

  it("keeps a worst-case bounded catalog well below the transport ceiling", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.listError = false;
    fixture.listDelayMs = 0;
    fixture.sessions = Array.from({ length: 500 }, (_, index) => ({
      id: `bounded-row-${index}`,
      sessionId: `bounded-session-${index}`,
      sessionName: `Bounded session ${index}`,
      summary: "\u0000".repeat(4_000),
      cwd: `/${"\u0000".repeat(5_000)}`,
      created: "not-a-date",
      modified: "not-a-date",
    }));
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      expect(backend.catalog().agents).toHaveLength(500);
      const serializedBytes = Buffer.byteLength(JSON.stringify(backend.catalog()), "utf8");
      expect(serializedBytes).toBeLessThan(12 * 1024 * 1024);
    } finally {
      fixture.sessions = originalSessions;
      hub.close();
      await backend.close();
    }
  });

  it("caps pending attention per agent and cancels the oldest requests", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.listError = false;
    fixture.snapshotDelayMs = 0;
    fixture.responseDelayMs = 0;
    fixture.responses = [];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      const listener = Reflect.get(fixture, "listener") as ((event: unknown) => void);
      for (let index = 0; index < 10; index += 1) {
        listener({
          type: "extension_ui_request",
          request: {
            id: `bounded-attention-${index}`,
            method: "select",
            payload: {
              title: "t".repeat(1_000),
              message: "m".repeat(10_000),
              options: Array.from({ length: 100 }, (_, option) => ({
                id: `option-${option}`.padEnd(300, "x"),
                label: "l".repeat(500),
              })),
            },
          },
        });
      }
      const snapshot = (await backend.agentSnapshot(agentId))!;
      expect(snapshot.attention).toHaveLength(8);
      expect(snapshot.attention[0]?.id).toBe("bounded-attention-2");
      expect(snapshot.attention.at(-1)?.id).toBe("bounded-attention-9");
      expect(snapshot.attention.every((request) =>
        request.title.length <= 200
        && (request.detail?.length ?? 0) <= 4_000
        && request.options.length <= 51)).toBe(true);
      expect(Reflect.get(backend, "pendingExtensions").size).toBe(8);
      expect(fixture.responses.slice(0, 2)).toEqual([
        { id: "bounded-attention-0", response: { cancelled: true } },
        { id: "bounded-attention-1", response: { cancelled: true } },
      ]);
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThan(4 * 1024 * 1024);
    } finally {
      fixture.responses = [];
      hub.close();
      await backend.close();
    }
  });

  it("reconnects after a daemon restart and rebuilds live connections", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSessions = fixture.sessions;
    fixture.sessions = originalSessions.map((session) => structuredClone(session));
    fixture.listError = false;
    fixture.connectError = false;
    fixture.snapshotError = false;
    fixture.listDelayMs = 0;
    fixture.snapshotDelayMs = 0;
    fixture.attachDelayMs = 0;
    fixture.attachCount = 0;
    fixture.attachOptions = null;
    fixture.disposed = 0;
    fixture.clientsCreated = 0;
    fixture.clientsClosed = 0;
    fixture.failClientsBelow = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    Reflect.set(backend, "catalogPollIntervalMs", 15);
    Reflect.set(backend, "reconnectDelaysMs", [10]);
    const hub = new EventHub();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      expect(fixture.attachCount).toBe(1);
      const frames: ServerFrame[] = [];
      const attached = hub.attach(`agent:${agentId}`, null, (frame) => frames.push(frame));

      // Restart: sockets held so far are permanently dead, and while the
      // daemon is down no new client can connect either.
      fixture.failClientsBelow = fixture.clientsCreated;
      fixture.connectError = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      const lostLogs = () => error.mock.calls.filter((call) =>
        call[0] === "Prime daemon connection lost; reconnecting with backoff");
      expect(lostLogs()).toHaveLength(1);

      // Repeated poll failures and failed reconnect attempts stay quiet.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(lostLogs()).toHaveLength(1);
      expect(fixture.clientsCreated).toBeGreaterThan(1);

      fixture.connectError = false;
      fixture.sessions[0].activeSessionId = "private-active-restarted";
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(error).toHaveBeenCalledWith("Prime daemon reconnected");
      expect(fixture.disposed).toBeGreaterThanOrEqual(1);
      expect(fixture.attachCount).toBe(2);
      expect(fixture.attachOptions).toMatchObject({ activeSessionId: "private-active-restarted" });
      expect(frames).toContainEqual(expect.objectContaining({
        type: "event",
        envelope: expect.objectContaining({
          event: expect.objectContaining({ kind: "agent.replaced" }),
        }),
      }));

      // New work goes through the replacement client.
      const snapshot = await backend.agentSnapshot(agentId);
      expect(snapshot?.messages[0]?.text).toBe("Ready");
      attached?.detach();
    } finally {
      fixture.sessions = originalSessions;
      fixture.listError = false;
      fixture.connectError = false;
      fixture.failClientsBelow = 0;
      error.mockRestore();
      hub.close();
      await backend.close();
    }
  });

  it("re-marks a failed connection refresh dirty and recovers by itself", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSnapshot = fixture.snapshot;
    fixture.snapshot = structuredClone(originalSnapshot);
    fixture.listError = false;
    fixture.connectError = false;
    fixture.snapshotError = false;
    fixture.snapshotDelayMs = 0;
    const backend = new PrimeBackend(moduleSpecifier());
    Reflect.set(backend, "connectionRefreshRetryDelaysMs", [10]);
    const hub = new EventHub();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      const frames: ServerFrame[] = [];
      const attached = hub.attach(`agent:${agentId}`, null, (frame) => frames.push(frame));
      const listener = Reflect.get(fixture, "listener") as (event: unknown) => void;

      fixture.snapshotCalls = 0;
      fixture.snapshotError = true;
      listener({ type: "streaming_update" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The failure retries on its own instead of going silently stale...
      expect(fixture.snapshotCalls).toBeGreaterThanOrEqual(2);
      // ...and logs the transition once, not every attempt.
      expect(error.mock.calls.filter((call) =>
        call[0] === "Prime agent refresh failed; retrying with backoff")).toHaveLength(1);

      fixture.snapshotError = false;
      (fixture.snapshot.state as Record<string, unknown>).recap = "Recovered refresh detail";
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(error).toHaveBeenCalledWith("Prime agent refresh recovered");
      const snapshot = await backend.agentSnapshot(agentId);
      expect(snapshot?.dashboard?.recap).toBe("Recovered refresh detail");
      expect(frames).toContainEqual(expect.objectContaining({
        type: "event",
        envelope: expect.objectContaining({
          event: expect.objectContaining({ kind: "agent.replaced" }),
        }),
      }));
      attached?.detach();
    } finally {
      fixture.snapshot = originalSnapshot;
      fixture.snapshotError = false;
      error.mockRestore();
      hub.close();
      await backend.close();
    }
  });

  it("caps python cell sections, flags truncation, and serves full output through the cell cache", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSnapshot = fixture.snapshot;
    fixture.snapshot = structuredClone(originalSnapshot);
    fixture.snapshot.messages = [
      { role: "user", content: "Run the analysis", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "cell-call-1", name: "ipython", arguments: { code: "c".repeat(17_000) } }],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        role: "toolResult",
        toolCallId: "cell-call-1",
        content: [{ type: "text", text: "duplicate of stdout" }],
        details: {
          status: "error",
          durationMs: 2_500,
          stdout: "s".repeat(7_000),
          stderr: "e".repeat(5_000),
          result: "r".repeat(5_000),
          error: { ename: "ValueError", evalue: "boom", traceback: "T".repeat(7_000) },
          diffs: Array.from({ length: 12 }, (_, index) => ({
            path: `src/file-${index}.ts`,
            oldStr: "o".repeat(4_500),
            newStr: "n".repeat(4_500),
            startLine: 3,
          })),
          kernelRestarted: true,
        },
        timestamp: "2026-01-01T00:00:04.000Z",
      },
    ];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      const snapshot = await backend.agentSnapshot(agentId);
      const row = snapshot!.messages.find((message) => message.presentation?.kind === "python");
      expect(row).toBeDefined();
      expect(row?.turnId).toBe(snapshot!.messages[0].id);
      expect(row?.state).toBe("failed");
      const presentation = row!.presentation as Extract<NonNullable<typeof row.presentation>, { kind: "python" }>;
      expect(presentation).toMatchObject({
        lang: "python",
        status: "failed",
        codeTruncated: true,
        stdoutTruncated: true,
        stderrTruncated: true,
        resultTruncated: true,
        diffsTruncated: true,
        durationMs: 2_500,
        kernelRestarted: true,
      });
      expect(presentation.code?.length).toBe(16_000);
      expect(presentation.stdout?.length).toBe(6_000);
      expect(presentation.stderr?.length).toBe(4_000);
      expect(presentation.result?.length).toBe(4_000);
      expect(presentation.error).toMatchObject({ ename: "ValueError", evalue: "boom", tracebackTruncated: true });
      expect(presentation.error?.traceback?.length).toBe(6_000);
      expect(presentation.diffs).toHaveLength(10);
      expect(presentation.diffs?.every((diff) =>
        diff.oldStr.length === 4_000 && diff.newStr.length === 4_000 && diff.truncated === true)).toBe(true);

      const cellId = presentation.cellId;
      expect(cellId).toMatch(/^cell_/);
      const full = backend.cellOutput(cellId!);
      expect(full).toMatchObject({ cellId, truncated: false });
      expect(full?.code?.length).toBe(17_000);
      expect(full?.stdout?.length).toBe(7_000);
      expect(full?.stderr?.length).toBe(5_000);
      expect(full?.result?.length).toBe(5_000);
      expect(full?.traceback?.length).toBe(7_000);
      expect(backend.cellOutput("cell_unknown")).toBeNull();
    } finally {
      fixture.snapshot = originalSnapshot;
      hub.close();
      await backend.close();
    }
  });

  it("enriches live refine outcomes and materializes unmatched ones as their own rows", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSnapshot = fixture.snapshot;
    fixture.snapshot = structuredClone(originalSnapshot);
    fixture.snapshot.messages = [
      { role: "user", content: "Please refine", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        role: "custom",
        customType: "session_slash_command",
        content: "/refine",
        display: true,
        details: { command: { name: "refine", text: "/refine" } },
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        role: "custom",
        customType: "session_slash_command_result",
        content: "Refined continual harness state: 1 edit applied.",
        display: true,
        details: { command: { name: "refine", text: "/refine" }, success: true },
        timestamp: "2026-01-01T00:00:02.000Z",
      },
    ];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      const listener = Reflect.get(fixture, "listener") as (event: unknown) => void;
      listener({
        type: "session_event",
        event: {
          type: "refine_complete",
          result: {
            id: "refinement-live",
            summary: "Captured drawer-testing guidance",
            rationale: "private rationale",
            scope: "global",
            appliedEdits: [
              { id: "edit-1", action: "create", kind: "memory", title: "Drawer overflow", applied: true },
              { id: "edit-2", action: "explode", kind: "memory", applied: true },
            ],
          },
        },
      });
      listener({
        type: "session_event",
        event: { type: "refine_failed", error: "Planner crashed at /Users/private-person/venv" },
      });
      await new Promise((resolve) => setTimeout(resolve, 120));

      const snapshot = await backend.agentSnapshot(agentId);
      const refines = snapshot!.messages.filter((message) => message.presentation?.kind === "refine");
      expect(refines).toHaveLength(2);
      // The /refine result row is enriched with the live outcome's details;
      // edits with unknown shapes are dropped rather than guessed at.
      expect(refines[0]).toMatchObject({
        text: "Captured drawer-testing guidance",
        presentation: {
          kind: "refine",
          status: "complete",
          summary: "Captured drawer-testing guidance",
          scope: "global",
          edits: [{ action: "create", kind: "memory", title: "Drawer overflow", applied: true }],
        },
      });
      // The failed outcome has no slash rows to pair with, so it gets its own row.
      expect(refines[1]).toMatchObject({
        role: "system",
        state: "failed",
        presentation: { kind: "refine", status: "failed", summary: "Refine failed" },
      });
      expect(JSON.stringify(refines[1])).not.toContain("/Users/");
      expect(JSON.stringify(snapshot)).not.toContain("private rationale");
      expect(snapshot?.dashboard?.refines.map((refine) => refine.status)).toEqual(["complete", "failed"]);
      expect(snapshot?.dashboard?.refines[0]).toMatchObject({
        id: refines[0].id,
        summary: "Captured drawer-testing guidance",
        scope: "global",
      });
    } finally {
      fixture.snapshot = originalSnapshot;
      hub.close();
      await backend.close();
    }
  });

  it("shows an in-progress refine row for a trailing /refine command", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSnapshot = fixture.snapshot;
    fixture.snapshot = structuredClone(originalSnapshot);
    fixture.snapshot.messages = [
      { role: "user", content: "Tune yourself up", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        role: "custom",
        customType: "session_slash_command",
        content: "/refine",
        display: true,
        details: { command: { name: "refine", text: "/refine" } },
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const agentId = backend.catalog().agents[0].id;
      const snapshot = await backend.agentSnapshot(agentId);
      const last = snapshot!.messages.at(-1);
      const command = snapshot!.messages.at(-2);
      expect(command).toMatchObject({ role: "user", text: "/refine" });
      expect(last).toMatchObject({
        role: "system",
        state: "streaming",
        turnId: command!.turnId,
        presentation: { kind: "refine", status: "running" },
      });
      expect(snapshot?.dashboard?.refines).toMatchObject([{ status: "running" }]);
    } finally {
      fixture.snapshot = originalSnapshot;
      hub.close();
      await backend.close();
    }
  });

  it("projects refine rows from saved sessions, enriching /refine results with persisted details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-mobile-refine-"));
    const sessionFile = join(directory, "session.jsonl");
    try {
      const refinement = {
        id: "refinement-1",
        summary: "Tightened the drawer-testing prompt",
        rationale: "private rationale",
        expectedOutcome: "Better drawer coverage",
        appliedEdits: [
          { id: "edit-1", action: "update", kind: "prompt", title: "Drawer testing", reason: "Missing overflow cases", applied: true },
          { id: "edit-2", action: "bogus", kind: "prompt", applied: true },
        ],
        harnessStatePath: "/private/harness-state.json",
        scope: "local",
      };
      const entries = [
        {
          type: "custom_message",
          customType: "session_slash_command",
          content: "/refine",
          display: true,
          details: { command: { name: "refine", text: "/refine" } },
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "custom_message",
          customType: "session_slash_command_result",
          content: "Refined continual harness state: 1 edit applied.",
          display: true,
          details: { command: { name: "refine", text: "/refine" }, success: true },
          timestamp: "2026-01-01T00:00:05.000Z",
        },
        { type: "custom", customType: "prime-agent.refinement", data: refinement, timestamp: "2026-01-01T00:00:06.000Z" },
        {
          type: "custom",
          customType: "prime-agent.refinement",
          data: { ...refinement, id: "refinement-2", summary: "Rolled back the prompt change", rollbackOf: "refinement-1" },
          timestamp: "2026-01-01T00:10:00.000Z",
        },
      ];
      await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

      const messages = await projectSavedSessionTranscript(sessionFile);
      const refines = messages.filter((message) => message.presentation?.kind === "refine");
      expect(refines).toHaveLength(2);
      expect(refines[0]).toMatchObject({
        role: "system",
        text: "Tightened the drawer-testing prompt",
        turnId: messages[0].id,
        presentation: {
          kind: "refine",
          status: "complete",
          summary: "Tightened the drawer-testing prompt",
          scope: "local",
          edits: [{ action: "update", kind: "prompt", title: "Drawer testing", reason: "Missing overflow cases", applied: true }],
        },
      });
      // A persisted refinement with no slash rows (auto-refine) becomes its own row.
      expect(refines[1]).toMatchObject({
        role: "system",
        presentation: { kind: "refine", status: "complete", rollback: true, summary: "Rolled back the prompt change" },
      });
      expect(JSON.stringify(messages)).not.toContain("private rationale");
      expect(JSON.stringify(messages)).not.toContain("harness-state.json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("assembles the dashboard and throttles context-stat probes to one per 20 seconds", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    const originalSnapshot = fixture.snapshot;
    const originalStats = fixture.sessionStats;
    fixture.snapshot = structuredClone(originalSnapshot);
    (fixture.snapshot.state as Record<string, unknown>).isCompacting = true;
    fixture.sessionStats = { contextUsage: { tokens: 1_000, contextWindow: 100_000, percent: 1 } };
    vi.useFakeTimers();
    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    try {
      const initializing = backend.initialize(hub);
      await vi.advanceTimersByTimeAsync(10);
      await initializing;
      const agentId = backend.catalog().agents[0].id;
      await backend.agentSnapshot(agentId);
      await vi.advanceTimersByTimeAsync(10);

      const first = await backend.agentSnapshot(agentId);
      expect(first?.dashboard).toMatchObject({ status: "compacting", needsInput: true });
      expect(first?.dashboard?.recap).toBeUndefined();
      expect(first?.dashboard?.contextUsage).toEqual({ tokens: 1_000, contextWindow: 100_000, percent: 1 });

      // A refresh inside the 20s window reuses the cached stats.
      fixture.sessionStats = { contextUsage: { tokens: 2_000, contextWindow: 100_000, percent: 2 } };
      const listener = Reflect.get(fixture, "listener") as (event: unknown) => void;
      listener({ type: "streaming_update" });
      await vi.advanceTimersByTimeAsync(500);
      expect((await backend.agentSnapshot(agentId))?.dashboard?.contextUsage)
        .toEqual({ tokens: 1_000, contextWindow: 100_000, percent: 1 });

      // Once the window has passed, the next refresh probes again.
      await vi.advanceTimersByTimeAsync(20_000);
      listener({ type: "streaming_update" });
      await vi.advanceTimersByTimeAsync(500);
      expect((await backend.agentSnapshot(agentId))?.dashboard?.contextUsage)
        .toEqual({ tokens: 2_000, contextWindow: 100_000, percent: 2 });
    } finally {
      vi.useRealTimers();
      fixture.snapshot = originalSnapshot;
      fixture.sessionStats = originalStats;
      hub.close();
      await backend.close();
    }
  });

});
