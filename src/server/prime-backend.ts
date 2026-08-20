import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ActivityItem,
  AgentCapabilities,
  AgentSnapshot,
  AgentSummary,
  AttentionRequest,
  CatalogSnapshot,
  MutationAccepted,
  TranscriptMessage,
} from "../protocol.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  type AbortInput,
  type AgentBackend,
  type ResolveAttentionInput,
  type SendMessageInput,
} from "./backend.js";
import type { EventHub } from "./event-hub.js";

interface PrimeResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PrimeSessionSummary {
  id: string;
  activeSessionId?: string;
  sessionId: string;
  sessionName?: string;
  lifecycle?: string;
  activity?: string;
  runtimeKind?: string;
  rlmDepth?: number;
  parentActiveSessionId?: string;
  parentSessionId?: string;
  isSessionActive?: boolean;
  isStreaming?: boolean;
  isCompacting?: boolean;
  isBashRunning?: boolean;
  hasRunningRlmChildren?: boolean;
  workerState?: string;
  taskState?: string;
  unfinishedActionCount?: number;
  lastActivityAt?: string;
  created?: string;
  modified?: string;
  summary?: string;
  firstMessage?: string;
}

interface PrimeSnapshot {
  state: {
    activeSessionId?: string;
    sessionId: string;
    sessionName?: string;
    isStreaming: boolean;
    isCompacting: boolean;
    isBashRunning: boolean;
    recap?: string;
  };
  messages: unknown[];
  streamingMessage?: unknown;
  children?: Array<{
    id: string;
    activeSessionId?: string;
    label: string;
    status: string;
    activity?: { kind: string; toolName?: string };
    error?: string;
  }>;
}

interface PrimeConnection {
  subscribe(listener: (event: PrimeConnectionEvent) => void | Promise<void>): () => void;
  getInitialSnapshot(): Promise<PrimeSnapshot>;
  prompt(message: string, options?: { queueIfBusy?: boolean }): Promise<void>;
  abort(): Promise<void>;
  respondToExtensionUiRequest(
    requestId: string,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): Promise<void>;
  dispose(): Promise<void> | void;
}

interface PrimeConnectionEvent {
  type: string;
  request?: { id: string; method: string; payload: Record<string, unknown> };
  error?: string;
  [key: string]: unknown;
}

interface PrimeDaemonClient {
  connect(timeoutMs?: number): Promise<void>;
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<PrimeResponse>;
  close(): void;
}

interface PrimeModule {
  DaemonClient: new (socketPath: string) => PrimeDaemonClient;
  DaemonAgentConnection: {
    attach(
      client: PrimeDaemonClient,
      activeSessionId: string,
      options: { closeClientOnDispose: boolean; supportsExtensionUi: boolean },
    ): Promise<PrimeConnection>;
  };
  defaultDaemonSocketPath(): string;
}

interface ConnectionRecord {
  publicId: string;
  connection: PrimeConnection;
  unsubscribe: () => void;
  refreshTimer?: NodeJS.Timeout;
  revision: number;
}

interface PendingExtension {
  publicAgentId: string;
  connection: PrimeConnection;
  method: string;
  payload: Record<string, unknown>;
  revision: number;
}

const defaultCapabilities: AgentCapabilities = {
  send: true,
  abort: true,
  resume: false,
  rename: false,
  stop: false,
  deactivate: false,
  delete: false,
  respond: true,
};

function opaqueId(value: string): string {
  return `agent_${createHash("sha256").update(value).digest("base64url").slice(0, 18)}`;
}

function toIso(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return String(message ?? "");
  const record = message as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .flatMap((part) => {
        if (typeof part === "string") return [part];
        if (!part || typeof part !== "object") return [];
        const value = part as Record<string, unknown>;
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("");
  }
  if (typeof record.text === "string") return record.text;
  return "";
}

function projectMessage(message: unknown, index: number, streaming: boolean): TranscriptMessage {
  const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
  const rawRole = record.role;
  const role = rawRole === "user" || rawRole === "assistant" || rawRole === "system" ? rawRole : "system";
  const stamp = typeof record.timestamp === "string" || typeof record.timestamp === "number" ? record.timestamp : index;
  const rawId = typeof record.id === "string" ? record.id : `${role}:${stamp}:${index}`;
  return {
    id: opaqueId(rawId),
    role,
    text: messageText(message),
    state: streaming ? "streaming" : "complete",
    createdAt: toIso(record.timestamp),
  };
}

function resolveModuleSpecifier(specifier: string): string {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(process.cwd(), specifier)).href;
  }
  return specifier;
}

export class PrimeBackend implements AgentBackend {
  readonly kind = "prime" as const;
  private hub!: EventHub;
  private module!: PrimeModule;
  private client!: PrimeDaemonClient;
  private catalogState: CatalogSnapshot = { revision: 0, agents: [] };
  private rawSummaries = new Map<string, PrimeSessionSummary>();
  private publicBySession = new Map<string, string>();
  private publicByActive = new Map<string, string>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly pendingExtensions = new Map<string, PendingExtension>();
  private pollTimer?: NodeJS.Timeout;
  private catalogFingerprint = "";

  constructor(
    private readonly moduleSpecifier: string,
    private readonly socketOverride?: string,
  ) {}

  async initialize(hub: EventHub): Promise<void> {
    this.hub = hub;
    const loaded = (await import(resolveModuleSpecifier(this.moduleSpecifier))) as Partial<PrimeModule>;
    if (!loaded.DaemonClient || !loaded.DaemonAgentConnection || !loaded.defaultDaemonSocketPath) {
      throw new Error(
        "The configured Prime Agent module does not export DaemonClient, DaemonAgentConnection, and defaultDaemonSocketPath. Use a compatible Prime Agent build.",
      );
    }
    this.module = loaded as PrimeModule;
    this.client = new this.module.DaemonClient(this.socketOverride || this.module.defaultDaemonSocketPath());
    await this.client.connect(5_000);
    await this.refreshCatalog(false);
    this.hub.register("catalog", this.catalogState);
    this.pollTimer = setInterval(() => void this.refreshCatalog(true).catch((error) => console.error("Prime catalog refresh failed", error)), 2_000);
  }

  catalog(): CatalogSnapshot {
    return structuredClone(this.catalogState);
  }

  async agentSnapshot(agentId: string): Promise<AgentSnapshot | null> {
    const summary = this.rawSummaries.get(agentId);
    if (!summary) return null;
    if (summary.activeSessionId) await this.ensureConnection(agentId, summary.activeSessionId);
    const existing = this.snapshots.get(agentId);
    if (existing) return structuredClone(existing);
    const inactive = this.projectInactiveSnapshot(agentId, summary);
    this.snapshots.set(agentId, inactive);
    this.hub.register(`agent:${agentId}`, inactive);
    return structuredClone(inactive);
  }

  async sendMessage(input: SendMessageInput): Promise<MutationAccepted> {
    const record = await this.requiredConnection(input.agentId);
    const snapshot = this.requiredSnapshot(input.agentId);
    if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    await record.connection.prompt(input.text, { queueIfBusy: true });
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async abort(input: AbortInput): Promise<MutationAccepted> {
    const record = await this.requiredConnection(input.agentId);
    const snapshot = this.requiredSnapshot(input.agentId);
    if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    await record.connection.abort();
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async resolveAttention(input: ResolveAttentionInput): Promise<MutationAccepted> {
    const pending = this.pendingExtensions.get(input.attentionId);
    if (!pending) throw new BackendNotFoundError("Attention request not found");
    if (pending.revision !== input.expectedRevision) throw new BackendConflictError("This request has already changed");
    const options = this.extensionOptions(pending);
    if (!options.some((option) => option.id === input.optionId)) {
      throw new BackendCapabilityError("Unknown response option");
    }
    let response: { value: string } | { confirmed: boolean } | { cancelled: true };
    if (input.optionId === "__prime_cancel__") response = { cancelled: true };
    else if (pending.method === "confirm") response = { confirmed: input.optionId === "confirm" };
    else if (pending.method === "select") response = { value: input.optionId };
    else response = { cancelled: true };
    await pending.connection.respondToExtensionUiRequest(input.attentionId, response);
    this.pendingExtensions.delete(input.attentionId);
    await this.refreshConnection(pending.publicAgentId);
    const revision = this.requiredSnapshot(pending.publicAgentId).revision;
    return { accepted: true, requestId: input.requestId, revision };
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const record of this.connections.values()) {
      if (record.refreshTimer) clearTimeout(record.refreshTimer);
      record.unsubscribe();
      await record.connection.dispose();
    }
    this.connections.clear();
    this.client?.close();
  }

  private async refreshCatalog(publish: boolean): Promise<void> {
    const response = await this.client.request({ type: "list", all: true });
    if (!response.success) throw new Error(response.error || "Prime daemon list failed");
    const sessions = (response.data as { sessions?: unknown } | undefined)?.sessions;
    if (!Array.isArray(sessions)) throw new Error("Prime daemon returned an invalid session list");
    const summaries = sessions.filter((value): value is PrimeSessionSummary => {
      if (!value || typeof value !== "object") return false;
      const record = value as Record<string, unknown>;
      return typeof record.id === "string" && typeof record.sessionId === "string";
    });

    this.publicBySession.clear();
    this.publicByActive.clear();
    for (const summary of summaries) {
      const publicId = opaqueId(summary.sessionId);
      this.publicBySession.set(summary.sessionId, publicId);
      if (summary.activeSessionId) this.publicByActive.set(summary.activeSessionId, publicId);
    }
    const projected = summaries.map((summary) => this.projectSummary(summary));
    const roots = new Map(projected.map((summary) => [summary.id, summary]));
    for (const item of projected) {
      let current = item;
      const seen = new Set<string>();
      while (current.parentId && roots.has(current.parentId) && !seen.has(current.id)) {
        seen.add(current.id);
        current = roots.get(current.parentId)!;
      }
      item.rootId = current.id;
    }
    for (const item of projected) item.childCount = projected.filter((candidate) => candidate.parentId === item.id).length;

    const nextFingerprint = JSON.stringify(projected);
    this.rawSummaries = new Map(summaries.map((summary) => [opaqueId(summary.sessionId), summary]));
    if (nextFingerprint === this.catalogFingerprint) return;
    this.catalogFingerprint = nextFingerprint;
    this.catalogState = { revision: this.catalogState.revision + 1, agents: projected };
    if (publish && this.hub.has("catalog")) {
      this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    }
  }

  private projectSummary(summary: PrimeSessionSummary): AgentSummary {
    const id = opaqueId(summary.sessionId);
    const parentId = summary.parentSessionId
      ? this.publicBySession.get(summary.parentSessionId) ?? null
      : summary.parentActiveSessionId
        ? this.publicByActive.get(summary.parentActiveSessionId) ?? null
        : null;
    const working = Boolean(
      summary.isSessionActive || summary.isStreaming || summary.isCompacting || summary.isBashRunning || summary.hasRunningRlmChildren,
    );
    const blocked = summary.taskState === "needs_input" || (summary.unfinishedActionCount ?? 0) > 0;
    const lifecycle = !summary.activeSessionId
      ? "inactive"
      : summary.workerState === "failed"
        ? "failed"
        : summary.workerState === "starting" || summary.workerState === "recovering"
          ? "starting"
          : "live";
    return {
      id,
      rootId: id,
      parentId,
      depth: Math.max(0, summary.rlmDepth ?? (parentId ? 1 : 0)),
      name: summary.sessionName || (parentId ? "Subagent" : "Agent"),
      description: summary.summary || (parentId ? "Delegated agent" : "Prime Agent session"),
      lifecycle,
      activity: blocked ? "blocked" : working ? "working" : "idle",
      attention: blocked ? "question" : null,
      unreadCount: blocked ? 1 : 0,
      childCount: 0,
      createdAt: toIso(summary.created || summary.lastActivityAt || summary.modified),
      updatedAt: toIso(summary.lastActivityAt || summary.modified || summary.created),
      capabilities: {
        ...defaultCapabilities,
        send: Boolean(summary.activeSessionId),
        abort: Boolean(summary.activeSessionId && working),
        resume: !summary.activeSessionId,
        respond: Boolean(summary.activeSessionId),
      },
    };
  }

  private async ensureConnection(publicId: string, activeSessionId: string): Promise<ConnectionRecord> {
    const existing = this.connections.get(publicId);
    if (existing) return existing;
    const connection = await this.module.DaemonAgentConnection.attach(this.client, activeSessionId, {
      closeClientOnDispose: false,
      supportsExtensionUi: true,
    });
    const buffered: PrimeConnectionEvent[] = [];
    let ready = false;
    const record: ConnectionRecord = {
      publicId,
      connection,
      revision: this.snapshots.get(publicId)?.revision ?? 0,
      unsubscribe: () => {},
    };
    record.unsubscribe = connection.subscribe((event) => {
      if (!ready) buffered.push(event);
      else this.handleConnectionEvent(record, event);
    });
    this.connections.set(publicId, record);
    const snapshot = await connection.getInitialSnapshot();
    this.applyPrimeSnapshot(record, snapshot, false);
    ready = true;
    for (const event of buffered) this.handleConnectionEvent(record, event);
    return record;
  }

  private handleConnectionEvent(record: ConnectionRecord, event: PrimeConnectionEvent): void {
    if (event.type === "extension_ui_request" && event.request) {
      const request = event.request;
      const revision = (this.snapshots.get(record.publicId)?.revision ?? 0) + 1;
      this.pendingExtensions.set(request.id, {
        publicAgentId: record.publicId,
        connection: record.connection,
        method: request.method,
        payload: request.payload,
        revision,
      });
    }
    if (event.type === "closed") {
      record.unsubscribe();
      this.connections.delete(record.publicId);
      void this.refreshCatalog(true);
      return;
    }
    if (record.refreshTimer) clearTimeout(record.refreshTimer);
    record.refreshTimer = setTimeout(() => void this.refreshConnection(record.publicId), 40);
  }

  private async refreshConnection(publicId: string): Promise<void> {
    const record = this.connections.get(publicId);
    if (!record) return;
    try {
      const snapshot = await record.connection.getInitialSnapshot();
      this.applyPrimeSnapshot(record, snapshot, true);
      await this.refreshCatalog(true);
    } catch (error) {
      console.error("Prime agent refresh failed", error);
    }
  }

  private applyPrimeSnapshot(record: ConnectionRecord, source: PrimeSnapshot, publish: boolean): void {
    record.revision += 1;
    const messages = source.messages.map((message, index) => projectMessage(message, index, false));
    if (source.streamingMessage) messages.push(projectMessage(source.streamingMessage, source.messages.length, true));
    const rawSummary = this.rawSummaries.get(record.publicId);
    const status: ActivityItem = {
      id: `${record.publicId}:status`,
      kind: "status",
      title: source.state.isStreaming
        ? "Agent is responding"
        : source.state.isCompacting
          ? "Compacting context"
          : source.state.isBashRunning
            ? "Running a command"
            : "Agent is idle",
      detail: source.state.recap,
      status: source.state.isStreaming || source.state.isCompacting || source.state.isBashRunning ? "running" : "complete",
      createdAt: new Date().toISOString(),
    };
    const childActivity: ActivityItem[] = (source.children ?? []).map((child) => ({
      id: `${record.publicId}:child:${child.id}`,
      kind: "child",
      title: child.label,
      detail: child.error || child.activity?.toolName,
      status: child.status === "error" ? "failed" : child.status === "done" ? "complete" : child.status === "queued" ? "waiting" : "running",
      createdAt: new Date().toISOString(),
      agentId: child.activeSessionId ? this.publicByActive.get(child.activeSessionId) : undefined,
    }));
    const attention = [...this.pendingExtensions.entries()]
      .filter(([, pending]) => pending.publicAgentId === record.publicId)
      .map(([id, pending]) => this.projectAttention(id, pending));
    const snapshot: AgentSnapshot = {
      revision: record.revision,
      agentId: record.publicId,
      messages,
      activity: [status, ...childActivity],
      attention,
    };
    this.snapshots.set(record.publicId, snapshot);
    const streamId = `agent:${record.publicId}`;
    if (!this.hub.has(streamId)) this.hub.register(streamId, snapshot);
    else if (publish) this.hub.publish(streamId, { kind: "agent.replaced", payload: snapshot }, snapshot);
    if (rawSummary && attention.length) rawSummary.taskState = "needs_input";
  }

  private extensionOptions(pending: PendingExtension): AttentionRequest["options"] {
    const cancel = { id: "__prime_cancel__", label: pending.method === "confirm" ? "Deny" : "Cancel", tone: "danger" as const };
    if (pending.method === "confirm") {
      return [cancel, { id: "confirm", label: "Allow once", tone: "safe" as const }];
    }
    if (pending.method !== "select" || !Array.isArray(pending.payload.options)) return [cancel];
    const projected = pending.payload.options.slice(0, 50).flatMap((value) => {
      if (typeof value === "string") {
        return value.length > 0 && value.length <= 160 && value !== cancel.id
          ? [{ id: value, label: value.slice(0, 200), tone: "default" as const }]
          : [];
      }
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const optionId = typeof item.value === "string" ? item.value : typeof item.id === "string" ? item.id : null;
      if (!optionId || optionId.length > 160 || optionId === cancel.id) return [];
      const label = typeof item.label === "string" ? item.label.slice(0, 200) : optionId;
      return [{ id: optionId, label, tone: "default" as const }];
    });
    return [...projected, cancel];
  }

  private projectAttention(id: string, pending: PendingExtension): AttentionRequest {
    const options = this.extensionOptions(pending);
    return {
      id,
      agentId: pending.publicAgentId,
      kind: pending.method === "confirm" ? "approval" : "question",
      title: typeof pending.payload.title === "string" ? pending.payload.title : pending.method === "confirm" ? "Approval required" : "Input required",
      detail: typeof pending.payload.message === "string" ? pending.payload.message : undefined,
      revision: pending.revision,
      options,
      createdAt: new Date().toISOString(),
    };
  }

  private projectInactiveSnapshot(publicId: string, summary: PrimeSessionSummary): AgentSnapshot {
    const messages: TranscriptMessage[] = summary.firstMessage
      ? [{ id: `${publicId}:first`, role: "user", text: summary.firstMessage, state: "complete", createdAt: toIso(summary.created) }]
      : [];
    return {
      revision: 1,
      agentId: publicId,
      messages,
      activity: [{ id: `${publicId}:inactive`, kind: "status", title: "Inactive session", status: "complete", createdAt: toIso(summary.modified) }],
      attention: [],
    };
  }

  private async requiredConnection(agentId: string): Promise<ConnectionRecord> {
    const summary = this.rawSummaries.get(agentId);
    if (!summary) throw new BackendNotFoundError("Agent not found");
    if (!summary.activeSessionId) throw new BackendCapabilityError("Resume this agent before interacting with it");
    return this.ensureConnection(agentId, summary.activeSessionId);
  }

  private requiredSnapshot(agentId: string): AgentSnapshot {
    const snapshot = this.snapshots.get(agentId);
    if (!snapshot) throw new BackendNotFoundError("Agent snapshot not loaded");
    return snapshot;
  }
}
