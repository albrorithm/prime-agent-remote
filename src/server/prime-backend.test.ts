import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackendCapabilityError } from "./backend.js";
import { EventHub } from "./event-hub.js";
import { PrimeBackend, projectPrimeTranscript, projectSavedSessionTranscript } from "./prime-backend.js";

interface FixtureState {
  sessions: Array<Record<string, unknown>>;
  snapshot: Record<string, unknown>;
  attachOptions: Record<string, unknown> | null;
  prompts: string[];
  aborts: number;
  responses: unknown[];
  creates: Array<Record<string, unknown>>;
  listener: ((event: unknown) => void) | null;
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
  }, {
    id: "saved-row",
    sessionId: "private-saved-session",
    firstMessage: "Refine the mobile session drawer behavior",
    created: "2026-01-02T00:00:00.000Z",
    modified: "2026-01-02T01:00:00.000Z",
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
    messages: [{ id: "message-1", role: "assistant", content: "Ready", timestamp: "2026-01-01T00:00:00.000Z" }],
    children: [],
  },
  attachOptions: null,
  prompts: [],
  aborts: 0,
  responses: [],
  creates: [],
  listener: null,
};

const moduleSource = `
const state = globalThis.__primeWebFixture;
export class DaemonClient {
  async connect() {}
  async request(command) {
    if (command.type === "create") {
      state.creates.push(command);
      state.createdCount = (state.createdCount ?? 0) + 1;
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
    if (command.type !== "list" || command.all !== true) return { success: false, error: "unexpected command" };
    return { success: true, data: { sessions: state.sessions } };
  }
  close() {}
}
const connection = {
  subscribe(listener) { state.listener = listener; return () => { state.listener = null; }; },
  async getInitialSnapshot() { return structuredClone(state.snapshot); },
  async prompt(message) { state.prompts.push(message); },
  async abort() { state.aborts += 1; },
  async respondToExtensionUiRequest(id, response) { state.responses.push({ id, response }); },
  async dispose() {},
};
export const DaemonAgentConnection = {
  async attach(client, activeSessionId, options) {
    state.attachOptions = { activeSessionId, ...options };
    return connection;
  },
};
export function defaultDaemonSocketPath() { return "/fixture/daemon.sock"; }
`;

function moduleSpecifier(): string {
  return `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}#${crypto.randomUUID()}`;
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { __primeWebFixture?: FixtureState }).__primeWebFixture;
});

describe("projectPrimeTranscript", () => {
  it("projects compact thinking and tool rows without forwarding tool output", () => {
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
      presentation: { kind: "thinking" },
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      text: "print(…)",
      presentation: { kind: "tool", label: "python", status: "complete", meta: "↑ 1 ↓ 1 lines" },
    });
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
      presentation: { kind: "tool", label: "python", status: "running" },
    });
  });
});

describe("PrimeBackend", () => {
  it("uses the public daemon adapter and validates browser approval choices", async () => {
    (globalThis as typeof globalThis & { __primeWebFixture: FixtureState }).__primeWebFixture = fixture;
    fixture.attachOptions = null;
    fixture.prompts = [];
    fixture.aborts = 0;
    fixture.responses = [];
    fixture.listener = null;

    const backend = new PrimeBackend(moduleSpecifier());
    const hub = new EventHub();
    await backend.initialize(hub);
    try {
      const summary = backend.catalog().agents[0];
      expect(summary.id).toMatch(/^agent_/);
      expect(summary.id).not.toContain("private-session");
      expect(summary).toMatchObject({ activity: "working", attention: null, unreadCount: 0, cwd: "/projects/alpha" });
      expect(backend.catalog().agents.find((agent) => agent.id !== summary.id)?.name)
        .toBe("Refine the mobile session drawer behavior");

      const snapshot = await backend.agentSnapshot(summary.id);
      expect(snapshot?.messages[0].text).toBe("Ready");
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

      await backend.sendMessage({ agentId: summary.id, requestId: crypto.randomUUID(), expectedRevision: snapshot!.revision, text: "Hello" });
      expect(fixture.prompts).toEqual(["Hello"]);

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
      expect(withAttention?.attention[0]).toMatchObject({ id: "request-1", kind: "approval", title: "Approve?" });
      expect(backend.catalog().agents[0].attention).toBe("approval");

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
        { role: "assistant", text: "The drawer needs an overflow lock." },
      ]);
      expect(messages[2].presentation).toEqual({
        kind: "tool",
        label: "python",
        status: "complete",
        meta: "↑ 1 ↓ 1 lines · 12ms",
      });
      expect(JSON.stringify(messages)).not.toContain("private tool output");
      expect(messages.every((message) => !message.id.includes("private"))).toBe(true);
      const liveSource: unknown[] = [];
      for (const entry of entries) {
        if (entry.type === "message") liveSource.push(entry.message);
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
          content: [{ type: "text", text: "x".repeat(1024 * 1024 + 100) }],
        },
      };
      await writeFile(sessionFile, `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`);

      const messages = await projectSavedSessionTranscript(sessionFile);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        text: "run_check()",
        state: "complete",
        presentation: { kind: "tool", label: "python", status: "unknown" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
