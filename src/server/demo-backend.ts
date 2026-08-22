import { randomUUID } from "node:crypto";
import path from "node:path";
import { SESSION_SLASH_COMMAND_NAMES } from "../protocol.js";
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
  SlashCommandAccepted,
  SlashCommandCatalog,
  SlashCommandResult,
  TranscriptMessage,
} from "../protocol.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  uniqueSessionName,
  type AttachmentData,
  type AbortInput,
  type AgentBackend,
  type CreateSessionInput,
  type ExecuteSlashCommandInput,
  type ResolveAttentionInput,
  type SendMessageInput,
} from "./backend.js";
import { absoluteDirectoryPath, directoryCrumbs, selectDirectoryEntries, type ListedChild } from "./directories.js";
import type { EventHub } from "./event-hub.js";
import { builtinSlashCommandEntries, detectedSlashCommandEntries, parseHeartbeatArgs } from "./slash-command-catalog.js";

const now = new Date().toISOString();
const DEMO_MAX_AGENTS = 128;
const DEMO_MAX_TRANSCRIPT_MESSAGES = 256;
const DEMO_MAX_TRANSCRIPT_TEXT_CHARS = 2 * 1024 * 1024;
const fullCapabilities: AgentCapabilities = {
  send: true,
  abort: true,
  resume: false,
  rename: true,
  stop: true,
  deactivate: true,
  delete: true,
  respond: true,
  images: false,
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
  private readonly models = new Map<string, { provider: string; modelId: string }>();
  private readonly efforts = new Map<string, string>();
  private readonly heartbeats = new Map<string, { status: "active" | "paused"; schedule: string; deliveryMode: "steer" | "follow_up" }>();
  private readonly commandLocks = new Map<string, Promise<void>>();
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

  attachment(_id: string): AttachmentData | null {
    return null;
  }

  async sendMessage(input: SendMessageInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    if (input.text.trimStart().startsWith("/")) throw new BackendCapabilityError("Use the session command endpoint");
    if (input.images.length > 0) throw new BackendCapabilityError("Demo mode does not accept image attachments");
    if (!summary.capabilities.send) this.wakeAgent(summary, snapshot);

    this.clearTimers(input.agentId);
    const superseded = [...snapshot.messages].reverse().find((item) => item.state === "streaming");
    if (superseded) {
      superseded.state = "failed";
      superseded.text = superseded.text || "Superseded by a newer message.";
      snapshot.revision += 1;
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_updated", payload: superseded }, snapshot);
    }
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
    const trimmed = this.trimTranscript(snapshot);
    snapshot.revision += 1;
    this.markAgent(input.agentId, "working", null);
    if (trimmed) {
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    } else {
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: userMessage }, snapshot);
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: assistantMessage }, snapshot);
    }

    const chunks = [
      "I received your message. ",
      "The demo backend is streaming through the same replayable protocol that the Prime adapter will use. ",
      "Reconnect now and the gateway will replay the missing events or send a fresh snapshot.",
    ];
    const timers: NodeJS.Timeout[] = [];
    chunks.forEach((chunk, index) => {
      const timer = setTimeout(() => {
        const current = this.snapshots.get(input.agentId);
        if (!current) return;
        const message = current.messages.find((item) => item.id === assistantId);
        if (!message || message.state !== "streaming") return;
        message.text += chunk;
        if (index === chunks.length - 1) {
          message.state = "complete";
          this.markAgent(input.agentId, "idle", null);
        }
        const trimmed = this.trimTranscript(current);
        this.hub.publish(
          `agent:${input.agentId}`,
          trimmed
            ? { kind: "agent.replaced", payload: current }
            : { kind: "agent.message_updated", payload: message },
          current,
        );
      }, 500 * (index + 1));
      timers.push(timer);
    });
    this.timers.set(input.agentId, timers);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async slashCommandCatalog(agentId: string): Promise<SlashCommandCatalog | null> {
    const summary = this.catalogState.agents.find((item) => item.id === agentId);
    const snapshot = this.snapshots.get(agentId);
    if (!summary || !snapshot) return null;
    const active = summary.capabilities.send;
    const currentModel = this.models.get(agentId) ?? { provider: "demo", modelId: "standard" };
    const currentEffort = this.efforts.get(agentId) ?? "medium";
    const builtins = builtinSlashCommandEntries({
      sessionCommandsAvailable: active,
      supportedDirectCommands: active
        ? new Set(["model", "effort", "name", "context", "heartbeat"])
        : new Set(),
      modelOptions: [
        { value: "demo/standard", label: "Demo Standard", current: currentModel.modelId === "standard" },
        { value: "demo/fast", label: "Demo Fast", current: currentModel.modelId === "fast" },
      ],
      effortOptions: ["low", "medium", "high"].map((value) => ({ value, label: value, current: value === currentEffort })),
      heartbeatOptions: [
        { value: "status", label: "Show status" },
        { value: "pause", label: "Pause" },
        { value: "resume", label: "Resume" },
        { value: "stop", label: "Stop and clear" },
      ],
    });
    const detected = detectedSlashCommandEntries([
      { name: "demo-extension", source: "extension", sourceInfo: { path: "/hidden/demo.ts" } },
    ], new Set(builtins.map((entry) => entry.name)));
    return { agentId, agentRevision: snapshot.revision, partial: false, commands: [...builtins, ...detected] };
  }

  async executeSlashCommand(input: ExecuteSlashCommandInput): Promise<SlashCommandAccepted> {
    return this.withCommandLock(input.agentId, () => this.executeSlashCommandLocked(input));
  }

  private async executeSlashCommandLocked(input: ExecuteSlashCommandInput): Promise<SlashCommandAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.send) throw new BackendCapabilityError("This agent cannot run commands");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");

    if (SESSION_SLASH_COMMAND_NAMES.includes(input.name as typeof SESSION_SLASH_COMMAND_NAMES[number])) {
      const createdAt = new Date().toISOString();
      const commandText = `/${input.name}${input.args ? ` ${input.args}` : ""}`;
      const commandMessage: TranscriptMessage = {
        id: input.requestId,
        role: "user",
        text: commandText,
        state: "complete",
        createdAt,
      };
      const resultMessage: TranscriptMessage = {
        id: randomUUID(),
        role: "system",
        text: `/${input.name} accepted.`,
        state: "complete",
        createdAt,
      };
      snapshot.messages.push(commandMessage, resultMessage);
      const trimmed = this.trimTranscript(snapshot);
      snapshot.revision += 1;
      if (trimmed) {
        this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
      } else {
        this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: commandMessage }, snapshot);
        this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: resultMessage }, snapshot);
      }
      return {
        accepted: true,
        requestId: input.requestId,
        revision: snapshot.revision,
        result: { kind: "session_accepted" },
      };
    }

    if (input.name === "demo-extension") {
      return {
        accepted: true,
        requestId: input.requestId,
        revision: snapshot.revision,
        result: { kind: "experimental_accepted", source: "extension" },
      };
    }

    let result: SlashCommandResult;
    let mutated = false;
    switch (input.name) {
      case "model": {
        if (!input.args) {
          const current = this.models.get(input.agentId) ?? { provider: "demo", modelId: "standard" };
          result = { kind: "model", ...current };
          break;
        }
        if (input.args !== "demo/standard" && input.args !== "demo/fast") {
          throw new BackendCapabilityError("Choose an exact available model");
        }
        const modelId = input.args.slice("demo/".length);
        this.models.set(input.agentId, { provider: "demo", modelId });
        mutated = true;
        result = { kind: "model", provider: "demo", modelId };
        break;
      }
      case "effort": {
        const levels = ["low", "medium", "high"];
        if (input.args && !levels.includes(input.args.toLowerCase())) {
          throw new BackendCapabilityError("Choose an available thinking level");
        }
        if (input.args) {
          this.efforts.set(input.agentId, input.args.toLowerCase());
          mutated = true;
        }
        result = { kind: "effort", level: this.efforts.get(input.agentId) ?? "medium", availableLevels: levels };
        break;
      }
      case "name": {
        if (input.args) {
          if (input.args.length > 200) throw new BackendCapabilityError("Session name is too long");
          summary.name = input.args;
          mutated = true;
          this.catalogState.revision += 1;
          this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
        }
        result = { kind: "name", ...(summary.name ? { name: summary.name } : {}) };
        break;
      }
      case "context": {
        if (input.args) throw new BackendCapabilityError("Context command does not accept arguments");
        result = { kind: "context_usage", contextTokens: 12_000, contextWindow: 200_000, percent: 6, totalTokens: 18_500, cost: 0.12 };
        break;
      }
      case "heartbeat": {
        const parsed = parseHeartbeatArgs(input.args);
        if (!parsed) throw new BackendCapabilityError("Invalid heartbeat command arguments");
        let heartbeat = this.heartbeats.get(input.agentId);
        if (parsed.type === "set") {
          heartbeat = { status: "active", schedule: parsed.schedule, deliveryMode: parsed.deliveryMode ?? "steer" };
          this.heartbeats.set(input.agentId, heartbeat);
          mutated = true;
        } else if (parsed.type === "pause" && heartbeat) {
          heartbeat = { ...heartbeat, status: "paused" };
          this.heartbeats.set(input.agentId, heartbeat);
          mutated = true;
        } else if (parsed.type === "resume" && heartbeat) {
          heartbeat = { ...heartbeat, status: "active" };
          this.heartbeats.set(input.agentId, heartbeat);
          mutated = true;
        } else if (parsed.type === "clear") {
          mutated = this.heartbeats.delete(input.agentId);
          heartbeat = undefined;
        }
        result = heartbeat
          ? { kind: "heartbeat", status: heartbeat.status, schedule: heartbeat.schedule, deliveryMode: heartbeat.deliveryMode }
          : { kind: "heartbeat", status: "none" };
        break;
      }
      default:
        throw new BackendCapabilityError("Command is not available");
    }
    if (mutated) {
      snapshot.revision += 1;
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    }
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision, result };
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
    if (this.catalogState.agents.length >= DEMO_MAX_AGENTS) {
      throw new BackendCapabilityError("Demo session limit reached");
    }
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
    this.commandLocks.clear();
  }

  private async withCommandLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.commandLocks.set(agentId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.commandLocks.get(agentId) === queued) this.commandLocks.delete(agentId);
    }
  }

  private wakeAgent(summary: AgentSummary, snapshot: AgentSnapshot): void {
    if (!summary.capabilities.resume) throw new BackendCapabilityError("This agent cannot receive messages");
    summary.lifecycle = "live";
    summary.activity = "idle";
    summary.capabilities = { ...fullCapabilities, resume: false };
    summary.updatedAt = new Date().toISOString();
    snapshot.revision += 1;
    snapshot.activity = [{
      id: `${summary.id}-activity`,
      kind: "status",
      title: "Agent is idle",
      status: "complete",
      createdAt: summary.updatedAt,
    }];
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    this.hub.publish(`agent:${summary.id}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
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

  private trimTranscript(snapshot: AgentSnapshot): boolean {
    const protectedMessages = new Set<TranscriptMessage>();
    snapshot.messages.forEach((message, index) => {
      if (message.state !== "streaming") return;
      protectedMessages.add(message);
      const previous = snapshot.messages[index - 1];
      if (previous?.role === "user") protectedMessages.add(previous);
    });
    const totalChars = () => snapshot.messages.reduce((total, message) => total + message.text.length, 0);
    let chars = totalChars();
    let trimmed = false;
    while (snapshot.messages.length > DEMO_MAX_TRANSCRIPT_MESSAGES || chars > DEMO_MAX_TRANSCRIPT_TEXT_CHARS) {
      const removableIndex = snapshot.messages.findIndex((message, index) =>
        index < snapshot.messages.length - 2 && !protectedMessages.has(message));
      if (removableIndex < 0) break;
      const [removed] = snapshot.messages.splice(removableIndex, 1);
      chars -= removed?.text.length ?? 0;
      trimmed = true;
    }
    return trimmed;
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
