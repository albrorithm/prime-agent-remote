import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ActivityItem,
  AgentCapabilities,
  AgentSnapshot,
  AgentSummary,
  AttentionRequest,
  CatalogSnapshot,
  DirectoryListing,
  MutationAccepted,
  SessionCreated,
  TranscriptMessage,
} from "../protocol.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  uniqueSessionName,
  type AbortInput,
  type AgentBackend,
  type CreateSessionInput,
  type ResolveAttentionInput,
  type SendMessageInput,
} from "./backend.js";
import { absoluteDirectoryPath, directoryCrumbs, selectDirectoryEntries, type ListedChild } from "./directories.js";
import type { EventHub } from "./event-hub.js";

const now = new Date().toISOString();
const fullCapabilities: AgentCapabilities = {
  send: true,
  abort: true,
  resume: false,
  rename: true,
  stop: true,
  deactivate: true,
  delete: true,
  respond: true,
};

function agent(
  input: Partial<AgentSummary> & Pick<AgentSummary, "id" | "rootId" | "parentId" | "depth" | "name">,
): AgentSummary {
  return {
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: now,
    updatedAt: now,
    capabilities: fullCapabilities,
    ...input,
  };
}

const initialAgents: AgentSummary[] = [
  agent({
    id: "root-mobile",
    rootId: "root-mobile",
    parentId: null,
    depth: 0,
    name: "Mobile WebUI",
    description: "Building the first-party mobile experience",
    cwd: "/projects/mobile-ui",
    activity: "working",
    childCount: 2,
  }),
  agent({
    id: "child-protocol",
    rootId: "root-mobile",
    parentId: "root-mobile",
    depth: 1,
    name: "Protocol designer",
    description: "Testing snapshot and replay semantics",
    activity: "working",
  }),
  agent({
    id: "child-review",
    rootId: "root-mobile",
    parentId: "root-mobile",
    depth: 1,
    name: "Security reviewer",
    description: "Waiting for an approval decision",
    activity: "blocked",
    attention: "approval",
    unreadCount: 1,
  }),
  agent({
    id: "root-research",
    rootId: "root-research",
    parentId: null,
    depth: 0,
    name: "Research archive",
    description: "Completed UI source audit",
    cwd: "/projects/prime-agent",
    activity: "idle",
  }),
  agent({
    id: "root-inactive",
    rootId: "root-inactive",
    parentId: null,
    depth: 0,
    name: "Previous session",
    description: "Available to resume",
    lifecycle: "inactive",
    activity: "idle",
    capabilities: { ...fullCapabilities, send: false, abort: false, resume: true, respond: false },
  }),
];

function initialSnapshot(summary: AgentSummary): AgentSnapshot {
  const messages: TranscriptMessage[] = [
    {
      id: `${summary.id}-welcome-user`,
      role: "user",
      text: summary.parentId ? summary.description ?? "Handle the delegated task." : "Build a reliable mobile interface for Prime Agent.",
      state: "complete",
      createdAt: now,
    },
    {
      id: `${summary.id}-welcome-assistant`,
      role: "assistant",
      text: summary.activity === "blocked" ? "I reviewed the requested action and need your approval before continuing." : "I’m working through the task. Live events will appear here.",
      state: "complete",
      createdAt: now,
    },
  ];
  const activity: ActivityItem[] = [
    {
      id: `${summary.id}-activity`,
      kind: summary.parentId ? "child" : "status",
      title: summary.activity === "blocked" ? "Waiting for input" : summary.activity === "working" ? "Agent is working" : "Agent is idle",
      status: summary.activity === "blocked" ? "waiting" : summary.activity === "working" ? "running" : "complete",
      createdAt: now,
    },
  ];
  const attention: AttentionRequest[] = summary.attention
    ? [
        {
          id: "attention-demo-approval",
          agentId: summary.id,
          kind: "approval",
          title: "Allow the proposed command?",
          detail: "Demo mode never executes this command. This card exercises the approval flow.",
          revision: 1,
          options: [
            { id: "deny", label: "Deny", tone: "danger" },
            { id: "allow-once", label: "Allow once", tone: "safe" },
          ],
          createdAt: now,
        },
      ]
    : [];
  return { revision: 1, agentId: summary.id, messages, activity, attention };
}

const demoTree = new Map<string, ListedChild[]>([
  ["/", [
    { name: "projects", path: "/projects", hidden: false, directory: true },
    { name: "Documents", path: "/Documents", hidden: false, directory: true },
  ]],
  ["/projects", [
    { name: "prime-agent", path: "/projects/prime-agent", hidden: false, directory: true },
    { name: "mobile-ui", path: "/projects/mobile-ui", hidden: false, directory: true },
    { name: ".secrets", path: "/projects/.secrets", hidden: true, directory: true },
  ]],
  ["/projects/prime-agent", []],
  ["/projects/mobile-ui", [
    { name: "src", path: "/projects/mobile-ui/src", hidden: false, directory: true },
  ]],
  ["/projects/mobile-ui/src", []],
  ["/Documents", []],
]);

export class DemoBackend implements AgentBackend {
  readonly kind = "demo" as const;
  private hub!: EventHub;
  private readonly catalogState: CatalogSnapshot = { revision: 1, agents: structuredClone(initialAgents) };
  private readonly snapshots = new Map(initialAgents.map((item) => [item.id, initialSnapshot(item)]));
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private createdCount = 0;

  async initialize(hub: EventHub): Promise<void> {
    this.hub = hub;
    hub.register("catalog", this.catalogState);
    for (const snapshot of this.snapshots.values()) hub.register(`agent:${snapshot.agentId}`, snapshot);
  }

  catalog(): CatalogSnapshot {
    return structuredClone(this.catalogState);
  }

  async agentSnapshot(agentId: string): Promise<AgentSnapshot | null> {
    const value = this.snapshots.get(agentId);
    return value ? structuredClone(value) : null;
  }

  async sendMessage(input: SendMessageInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.send) throw new BackendCapabilityError("This agent cannot receive messages");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");

    this.clearTimers(input.agentId);
    const createdAt = new Date().toISOString();
    const userMessage: TranscriptMessage = {
      id: input.requestId,
      role: "user",
      text: input.text,
      state: "complete",
      createdAt,
    };
    const assistantId = randomUUID();
    const assistantMessage: TranscriptMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      state: "streaming",
      createdAt,
    };
    snapshot.messages.push(userMessage, assistantMessage);
    snapshot.revision += 1;
    this.markAgent(input.agentId, "working", null);
    this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: userMessage }, snapshot);
    this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: assistantMessage }, snapshot);

    const chunks = [
      "I received your message. ",
      "The demo backend is streaming through the same replayable protocol that the Prime adapter will use. ",
      "Reconnect now and the gateway will replay the missing events or send a fresh snapshot.",
    ];
    const timers: NodeJS.Timeout[] = [];
    chunks.forEach((chunk, index) => {
      timers.push(
        setTimeout(() => {
          const current = this.snapshots.get(input.agentId);
          if (!current) return;
          const message = current.messages.find((item) => item.id === assistantId);
          if (!message || message.state !== "streaming") return;
          message.text += chunk;
          if (index === chunks.length - 1) {
            message.state = "complete";
            this.markAgent(input.agentId, "idle", null);
          }
          this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_updated", payload: message }, current);
        },
        500 * (index + 1),
      ),
    );
    });
    this.timers.set(input.agentId, timers);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async abort(input: AbortInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.abort) throw new BackendCapabilityError("This agent cannot be aborted");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    this.clearTimers(input.agentId);
    const streaming = [...snapshot.messages].reverse().find((item: TranscriptMessage) => item.state === "streaming");
    if (streaming) {
      streaming.state = "failed";
      streaming.text = streaming.text || "Stopped.";
      snapshot.revision += 1;
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_updated", payload: streaming }, snapshot);
    }
    this.markAgent(input.agentId, "idle", null);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async resolveAttention(input: ResolveAttentionInput): Promise<MutationAccepted> {
    const snapshot = [...this.snapshots.values()].find((value) => value.attention.some((item) => item.id === input.attentionId));
    if (!snapshot) throw new BackendNotFoundError("Attention request not found");
    const request = snapshot.attention.find((item) => item.id === input.attentionId)!;
    if (input.expectedRevision !== request.revision) throw new BackendConflictError("This request has already changed");
    if (!request.options.some((option) => option.id === input.optionId)) throw new BackendCapabilityError("Unknown response option");
    snapshot.attention = snapshot.attention.filter((item) => item.id !== input.attentionId);
    snapshot.revision += 1;
    this.markAgent(snapshot.agentId, "idle", null);
    this.hub.publish(`agent:${snapshot.agentId}`, { kind: "agent.attention_resolved", payload: { id: input.attentionId } }, snapshot);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async listDirectories(requestedPath?: string): Promise<DirectoryListing> {
    const target = absoluteDirectoryPath(requestedPath, "/");
    const children = demoTree.get(target);
    if (!children) throw new BackendNotFoundError("Directory not found");
    const { entries, truncated } = selectDirectoryEntries(children);
    return { path: target, home: "/", crumbs: directoryCrumbs(target), entries, truncated };
  }

  async createSession(input: CreateSessionInput): Promise<SessionCreated> {
    if (!demoTree.has(input.cwd)) throw new BackendNotFoundError("Directory not found");
    this.createdCount += 1;
    const id = `root-created-${this.createdCount}`;
    const baseName = input.name?.trim() || path.basename(input.cwd) || `New session ${this.createdCount}`;
    const summary = agent({
      id,
      rootId: id,
      parentId: null,
      depth: 0,
      name: uniqueSessionName(baseName, this.catalogState.agents.map((item) => item.name)),
      description: `Created in ${input.cwd}`,
      activity: "idle",
      cwd: input.cwd,
    });
    this.catalogState.agents.push(summary);
    this.catalogState.revision += 1;
    this.snapshots.set(id, { revision: 1, agentId: id, messages: [], activity: [], attention: [] });
    this.hub.register(`agent:${id}`, this.snapshots.get(id)!);
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    return { requestId: input.requestId, agentId: id };
  }

  async close(): Promise<void> {
    for (const agentId of this.timers.keys()) this.clearTimers(agentId);
  }

  private requiredSnapshot(agentId: string): AgentSnapshot {
    const value = this.snapshots.get(agentId);
    if (!value) throw new BackendNotFoundError("Agent not found");
    return value;
  }

  private requiredSummary(agentId: string): AgentSummary {
    const value = this.catalogState.agents.find((item) => item.id === agentId);
    if (!value) throw new BackendNotFoundError("Agent not found");
    return value;
  }

  private markAgent(agentId: string, activity: AgentSummary["activity"], attention: AgentSummary["attention"]): void {
    const summary = this.requiredSummary(agentId);
    summary.activity = activity;
    summary.attention = attention;
    summary.unreadCount = attention ? 1 : 0;
    summary.updatedAt = new Date().toISOString();
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
  }

  private clearTimers(agentId: string): void {
    for (const timer of this.timers.get(agentId) ?? []) clearTimeout(timer);
    this.timers.delete(agentId);
  }
}
