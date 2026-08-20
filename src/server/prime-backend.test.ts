import { afterEach, describe, expect, it } from "vitest";
import { BackendCapabilityError } from "./backend.js";
import { EventHub } from "./event-hub.js";
import { PrimeBackend } from "./prime-backend.js";

interface FixtureState {
  sessions: Array<Record<string, unknown>>;
  snapshot: Record<string, unknown>;
  attachOptions: Record<string, unknown> | null;
  prompts: string[];
  aborts: number;
  responses: unknown[];
  listener: ((event: unknown) => void) | null;
}

const fixture: FixtureState = {
  sessions: [{ id: "daemon-row", sessionId: "private-session", activeSessionId: "private-active", sessionName: "Live agent" }],
  snapshot: {
    state: { sessionId: "private-session", activeSessionId: "private-active", sessionName: "Live agent", isStreaming: false, isCompacting: false, isBashRunning: false },
    messages: [{ id: "message-1", role: "assistant", content: "Ready", timestamp: "2026-01-01T00:00:00.000Z" }],
    children: [],
  },
  attachOptions: null,
  prompts: [],
  aborts: 0,
  responses: [],
  listener: null,
};

const moduleSource = `
const state = globalThis.__primeWebFixture;
export class DaemonClient {
  async connect() {}
  async request(command) {
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

      const snapshot = await backend.agentSnapshot(summary.id);
      expect(snapshot?.messages[0].text).toBe("Ready");
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
        request: { id: "request-1", method: "confirm", payload: { title: "Approve?", message: "Review this action" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      const withAttention = await backend.agentSnapshot(summary.id);
      expect(withAttention?.attention[0]).toMatchObject({ id: "request-1", kind: "approval", title: "Approve?" });

      await expect(backend.resolveAttention({
        attentionId: "request-1",
        requestId: crypto.randomUUID(),
        expectedRevision: withAttention!.attention[0].revision,
        optionId: "invented-option",
      })).rejects.toBeInstanceOf(BackendCapabilityError);
      expect(fixture.responses).toHaveLength(0);

      await backend.resolveAttention({
        attentionId: "request-1",
        requestId: crypto.randomUUID(),
        expectedRevision: withAttention!.attention[0].revision,
        optionId: "confirm",
      });
      expect(fixture.responses).toEqual([{ id: "request-1", response: { confirmed: true } }]);

      const latest = await backend.agentSnapshot(summary.id);
      await backend.abort({ agentId: summary.id, requestId: crypto.randomUUID(), expectedRevision: latest!.revision });
      expect(fixture.aborts).toBe(1);
    } finally {
      hub.close();
      await backend.close();
    }
  });
});
