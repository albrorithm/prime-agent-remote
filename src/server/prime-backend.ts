import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import type {
  ActivityItem,
  AgentCapabilities,
  AgentGoal,
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
import {
  absoluteDirectoryPath,
  directoryCrumbs,
  selectDirectoryEntries,
  type ListedChild,
} from "./directories.js";
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
  sessionFile?: string;
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
  cwd?: string;
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
    goal?: {
      active?: boolean;
      status?: string;
      objective?: string;
      tokenBudget?: number;
      tokensUsed?: number;
      timeUsedSeconds?: number;
      continuationsUsed?: number;
      updatedAt?: number;
      lastReason?: string;
      lastError?: string;
    };
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
  method: "confirm" | "select";
  payload: Record<string, unknown>;
  revision: number;
  timer?: NodeJS.Timeout;
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

function isEmptyStub(summary: PrimeSessionSummary): boolean {
  const firstMessage = typeof summary.firstMessage === "string" ? summary.firstMessage.trim() : "";
  const hasTitle = Boolean(summary.sessionName || summary.summary || (firstMessage && firstMessage !== "(no messages)"));
  if (hasTitle) return false;
  return !summary.activeSessionId || summary.lifecycle === "draft";
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

const SAVED_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const SAVED_TRANSCRIPT_MAX_LINE_CHARS = 1024 * 1024;
const SAVED_TRANSCRIPT_MAX_MESSAGES = 1_000;
const SAVED_TRANSCRIPT_MAX_TEXT_CHARS = 2 * 1024 * 1024;
const SAVED_TRANSCRIPT_MAX_MESSAGE_CHARS = 120_000;

function conciseTitle(value: unknown, maxChars = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title || title === "(no messages)") return undefined;
  return title.length > maxChars ? `${title.slice(0, maxChars - 1).trimEnd()}…` : title;
}

/** Project only conversational text from a daemon-designated session file. */
export async function projectSavedSessionTranscript(sessionFile: string): Promise<TranscriptMessage[]> {
  try {
    const file = await stat(sessionFile);
    if (!file.isFile() || file.size <= 0) return [];
    const start = Math.max(0, file.size - SAVED_TRANSCRIPT_SCAN_BYTES);
    const stream = createReadStream(sessionFile, { start, end: file.size - 1, highWaterMark: 64 * 1024 });
    const decoder = new StringDecoder("utf8");
    const messages: TranscriptMessage[] = [];
    let totalTextChars = 0;
    let currentLine = "";
    let droppingLine = false;
    let index = 0;

    const consumeLine = (line: string) => {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return;
      const source = entry.message as Record<string, unknown>;
      if (source.role !== "user" && source.role !== "assistant") return;
      const text = messageText(source).slice(0, SAVED_TRANSCRIPT_MAX_MESSAGE_CHARS);
      if (!text) return;
      const rawId = typeof entry.id === "string" ? entry.id : `${source.role}:${String(entry.timestamp ?? index)}:${index}`;
      const projected: TranscriptMessage = {
        id: opaqueId(rawId),
        role: source.role,
        text,
        state: "complete",
        createdAt: toIso(entry.timestamp ?? source.timestamp),
      };
      index += 1;
      messages.push(projected);
      totalTextChars += projected.text.length;
      while (messages.length > SAVED_TRANSCRIPT_MAX_MESSAGES || totalTextChars > SAVED_TRANSCRIPT_MAX_TEXT_CHARS) {
        totalTextChars -= messages.shift()?.text.length ?? 0;
      }
    };

    const consumeChunk = (chunk: string, final = false) => {
      const parts = chunk.split("\n");
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const terminated = partIndex < parts.length - 1;
        const part = parts[partIndex];
        if (!droppingLine) {
          if (currentLine.length + part.length <= SAVED_TRANSCRIPT_MAX_LINE_CHARS) currentLine += part;
          else {
            currentLine = "";
            droppingLine = true;
          }
        }
        if (terminated) {
          if (!droppingLine && currentLine.trim()) consumeLine(currentLine);
          currentLine = "";
          droppingLine = false;
        }
      }
      if (final && !droppingLine && currentLine.trim()) consumeLine(currentLine);
    };

    for await (const chunk of stream) consumeChunk(decoder.write(chunk as Buffer));
    consumeChunk(decoder.end(), true);
    return messages;
  } catch {
    return [];
  }
}

function projectGoal(source: PrimeSnapshot["state"]["goal"]): AgentGoal | undefined {
  if (!source || typeof source.objective !== "string") return undefined;
  const objective = source.objective.trim().slice(0, 4000);
  if (!objective) return undefined;
  const allowed = new Set<AgentGoal["status"]>(["active", "paused", "budget_limited", "complete", "error"]);
  const status = allowed.has(source.status as AgentGoal["status"])
    ? source.status as AgentGoal["status"]
    : source.active
      ? "active"
      : "paused";
  const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return {
    status,
    objective,
    tokenBudget: typeof source.tokenBudget === "number" && Number.isFinite(source.tokenBudget)
      ? Math.max(0, Math.trunc(source.tokenBudget))
      : undefined,
    tokensUsed: nonnegative(source.tokensUsed),
    timeUsedSeconds: nonnegative(source.timeUsedSeconds),
    continuationsUsed: nonnegative(source.continuationsUsed),
    updatedAt: typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt) ? toIso(source.updatedAt) : undefined,
    lastReason: typeof source.lastReason === "string" ? source.lastReason.slice(0, 1000) : undefined,
    lastError: typeof source.lastError === "string" ? source.lastError.slice(0, 1000) : undefined,
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
    const inactive = await this.projectInactiveSnapshot(agentId, summary);
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
    if (pending.method === "confirm") response = { confirmed: input.optionId === "confirm" };
    else if (input.optionId === "__prime_cancel__") response = { cancelled: true };
    else response = { value: input.optionId };
    await pending.connection.respondToExtensionUiRequest(input.attentionId, response);
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingExtensions.delete(input.attentionId);
    await this.refreshConnection(pending.publicAgentId);
    const revision = this.requiredSnapshot(pending.publicAgentId).revision;
    return { accepted: true, requestId: input.requestId, revision };
  }

  async listDirectories(requestedPath?: string): Promise<DirectoryListing> {
    const home = homedir();
    const target = absoluteDirectoryPath(requestedPath, home);
    const children: ListedChild[] = [];
    let handle;
    try {
      handle = await opendir(target);
      for (;;) {
        let entry;
        try {
          entry = await handle.read();
        } catch {
          break;
        }
        if (!entry) break;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const childPath = path.join(target, entry.name);
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            directory = (await stat(childPath)).isDirectory();
          } catch {
            continue;
          }
        }
        if (!directory) continue;
        children.push({ name: entry.name, path: childPath, hidden: entry.name.startsWith("."), directory: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        throw new BackendNotFoundError("Directory not found");
      }
      throw new BackendCapabilityError("Directory cannot be listed");
    } finally {
      await handle?.close().catch(() => {});
    }
    const { entries, truncated } = selectDirectoryEntries(children);
    return { path: target, home, crumbs: directoryCrumbs(target), entries, truncated };
  }

  async createSession(input: CreateSessionInput): Promise<SessionCreated> {
    if (!path.isAbsolute(input.cwd)) throw new BackendCapabilityError("Working directory must be an absolute path");
    const baseName = input.name?.trim() || path.basename(input.cwd) || "New session";
    const name = uniqueSessionName(baseName, this.catalogState.agents.map((agent) => agent.name));
    const response = await this.client.request({
      type: "create",
      name,
      config: { cwd: input.cwd },
    });
    if (!response.success) throw new BackendNotFoundError(response.error || "The daemon could not create the session");
    const data = (response.data ?? {}) as { activeSessionId?: string; sessionId?: string };
    const activeSessionId = typeof data.activeSessionId === "string" ? data.activeSessionId : null;
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : null;
    await this.refreshCatalog(true);
    const publicId = (activeSessionId && this.publicByActive.get(activeSessionId))
      ?? (sessionId && this.publicBySession.get(sessionId))
      ?? null;
    if (!publicId) throw new BackendNotFoundError("The created session did not appear in the catalog");
    await this.agentSnapshot(publicId);
    return { requestId: input.requestId, agentId: publicId };
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const pending of this.pendingExtensions.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pendingExtensions.clear();
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
    const projected = summaries
      .filter((summary) => !isEmptyStub(summary))
      .map((summary) => this.projectSummary(summary));
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
    const hasActiveWork = Boolean(
      summary.isStreaming || summary.isCompacting || summary.isBashRunning ||
      summary.hasRunningRlmChildren || (summary.unfinishedActionCount ?? 0) > 0,
    );
    const working = Boolean(summary.activeSessionId) && (
      hasActiveWork || (summary.lifecycle !== "draft" && summary.activity === "working")
    );
    const pending = [...this.pendingExtensions.values()].find((request) => request.publicAgentId === id);
    const attention = pending?.method === "confirm" ? "approval" : pending ? "question" : null;
    const lifecycle = !summary.activeSessionId
      ? "inactive"
      : summary.workerState === "failed"
        ? "failed"
        : summary.lifecycle === "draft" || summary.workerState === "starting" || summary.workerState === "recovering"
          ? "starting"
          : "live";
    const name = conciseTitle(summary.sessionName)
      ?? conciseTitle(summary.firstMessage)
      ?? conciseTitle(summary.summary)
      ?? (parentId ? "Subagent" : "Untitled session");
    return {
      id,
      rootId: id,
      parentId,
      depth: Math.max(0, summary.rlmDepth ?? (parentId ? 1 : 0)),
      name,
      description: summary.summary || (parentId ? "Delegated agent" : "Prime Agent session"),
      cwd: typeof summary.cwd === "string" && summary.cwd ? summary.cwd : undefined,
      lifecycle,
      activity: attention ? "blocked" : working ? "working" : "idle",
      attention,
      unreadCount: attention ? 1 : 0,
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
      if (request.method === "input" || request.method === "editor") {
        void record.connection.respondToExtensionUiRequest(request.id, { cancelled: true }).catch((error) =>
          console.error("Could not cancel unsupported Prime text dialog", error),
        );
      } else if (request.method === "confirm" || request.method === "select") {
        const revision = (this.snapshots.get(record.publicId)?.revision ?? 0) + 1;
        const pending: PendingExtension = {
          publicAgentId: record.publicId,
          connection: record.connection,
          method: request.method,
          payload: request.payload,
          revision,
        };
        const timeout = Number(request.payload.timeout);
        if (Number.isFinite(timeout) && timeout > 0) {
          pending.timer = setTimeout(() => {
            if (this.pendingExtensions.get(request.id) !== pending) return;
            this.pendingExtensions.delete(request.id);
            void this.refreshConnection(record.publicId);
          }, timeout);
        }
        this.pendingExtensions.set(request.id, pending);
      }
    }
    if (event.type === "closed") {
      record.unsubscribe();
      this.clearPendingExtensions(record.publicId);
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
      goal: projectGoal(source.state.goal),
    };
    this.snapshots.set(record.publicId, snapshot);
    const streamId = `agent:${record.publicId}`;
    if (!this.hub.has(streamId)) this.hub.register(streamId, snapshot);
    else if (publish) this.hub.publish(streamId, { kind: "agent.replaced", payload: snapshot }, snapshot);
  }

  private clearPendingExtensions(publicId: string): void {
    for (const [id, pending] of this.pendingExtensions) {
      if (pending.publicAgentId !== publicId) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingExtensions.delete(id);
    }
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

  private async projectInactiveSnapshot(publicId: string, summary: PrimeSessionSummary): Promise<AgentSnapshot> {
    const messages = summary.sessionFile ? await projectSavedSessionTranscript(summary.sessionFile) : [];
    const fallback = conciseTitle(summary.firstMessage, 4_000);
    if (!messages.length && fallback) {
      messages.push({ id: `${publicId}:first`, role: "user", text: fallback, state: "complete", createdAt: toIso(summary.created) });
    }
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
