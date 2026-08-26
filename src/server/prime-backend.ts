import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import {
  DIRECT_SLASH_COMMAND_NAMES,
  MAX_IMAGE_REQUEST_BASE64_CHARS,
  SESSION_SLASH_COMMAND_NAMES,
} from "../protocol.js";
import type {
  AgentCapabilities,
  AgentGoal,
  AgentSnapshot,
  AgentSummary,
  AttentionRequest,
  CatalogSnapshot,
  CellOutput,
  DirectoryListing,
  ImageAttachmentInput,
  TranscriptAttachment,
  MutationAccepted,
  RefineEditAction,
  RefineEditKind,
  SessionContextUsage,
  SessionCreated,
  SessionDashboard,
  SessionDashboardChild,
  SessionDashboardRefine,
  SlashCommandAccepted,
  SlashCommandCatalog,
  SlashCommandCatalogEntry,
  SlashCommandOption,
  SlashCommandResult,
  TranscriptMessage,
  TranscriptPresentation,
  TranscriptToolStatus,
} from "../protocol.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  CoalescedRefreshQueue,
  uniqueSessionName,
  withSerialLock,
  type AttachmentData,
  type AbortInput,
  type AgentBackend,
  type AttentionListener,
  type CreateSessionInput,
  type ExecuteSlashCommandInput,
  type DeleteInput,
  type RenameInput,
  type StopInput,
  type ResolveAttentionInput,
  type SendMessageInput,
} from "./backend.js";
import {
  absoluteDirectoryPath,
  directoryCrumbs,
  DIRECTORY_SCAN_BOUND,
  selectDirectoryEntries,
  type ListedChild,
} from "./directories.js";
import type { EventHub } from "./event-hub.js";
import {
  ImageAttachmentValidationError,
  validateImageAttachments,
  type ValidatedImageAttachment,
} from "./image-attachments.js";
import {
  builtinSlashCommandEntries,
  detectedSlashCommandEntries,
  parseHeartbeatArgs,
} from "./slash-command-catalog.js";
import { sanitizeTranscriptPreview, summarizeBashExecution, summarizeToolCall, thinkingRecap } from "./transcript-previews.js";

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
  model?: { input?: string[] };
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
    durationMs?: number;
    answerPreview?: string;
    toolUseCount?: number;
    tokenCount?: number;
    recap?: string;
    error?: string;
  }>;
}

interface PrimeModel {
  provider: string;
  id: string;
  name?: string;
}

interface PrimeConnectionState {
  sessionName?: string;
  model?: PrimeModel;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
}

interface PrimeHeartbeat {
  status?: string;
  deliveryMode?: string;
  schedule?: { expression?: string };
  nextRunAt?: string;
}

interface PrimeSessionStats {
  tokens?: { total?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

interface PrimeConnection {
  subscribe(listener: (event: PrimeConnectionEvent) => void | Promise<void>): () => void;
  getInitialSnapshot(): Promise<PrimeSnapshot>;
  getCommands?(): Promise<Array<{ name?: unknown; source?: unknown; [key: string]: unknown }>>;
  getAvailableModels?(): Promise<PrimeModel[]>;
  getState?(): Promise<PrimeConnectionState>;
  setModel?(provider: string, modelId: string): Promise<PrimeModel>;
  setThinkingLevel?(level: string): Promise<void>;
  setSessionName?(name: string): Promise<void>;
  getSessionStats?(): Promise<PrimeSessionStats>;
  getHeartbeat?(): Promise<PrimeHeartbeat | undefined>;
  setHeartbeat?(schedule: string, instruction: string, deliveryMode?: "steer" | "follow_up"): Promise<PrimeHeartbeat>;
  updateHeartbeat?(action: "pause" | "resume" | "clear"): Promise<PrimeHeartbeat | undefined>;
  prompt(message: string, options?: {
    queueIfBusy?: boolean;
    streamingBehavior?: "steer" | "followUp";
    images?: ImageAttachmentInput[];
  }): Promise<void>;
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
  /** Newer daemon builds expose an emitter surface; older ones only fail requests. */
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
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

type RefinePresentation = Extract<TranscriptPresentation, { kind: "refine" }>;
type PythonPresentation = Extract<TranscriptPresentation, { kind: "python" }>;

interface StoredRefine {
  key: string;
  createdAt: string;
  presentation: RefinePresentation;
}

interface ConnectionRecord {
  publicId: string;
  activeSessionId: string;
  connection: PrimeConnection;
  unsubscribe: () => void;
  refreshQueue: CoalescedRefreshQueue;
  disposed: boolean;
  revision: number;
  /** Refine outcomes observed live on this connection, in arrival order. */
  refines: StoredRefine[];
  contextStats?: { fetchedAt: number; value?: SessionContextUsage };
  contextStatsPending?: Promise<void>;
}

interface PendingExtension {
  publicAgentId: string;
  connection: PrimeConnection;
  method: "confirm" | "select";
  payload: Record<string, unknown>;
  revision: number;
  createdAt: string;
  timer?: NodeJS.Timeout;
}

const ATTACHMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_CATALOG_SESSIONS = 500;
const MAX_CATALOG_DESCRIPTION_CHARS = 1_000;
const MAX_CATALOG_CWD_CHARS = 2_048;
const MAX_CATALOG_REFRESH_BATCH = 4;
const MAX_SNAPSHOT_MESSAGES = 1_000;
const MAX_SNAPSHOT_CHILDREN = 250;
const MAX_MESSAGE_PARTS = 250;
const MAX_PROJECTED_ATTACHMENTS = 8;
const MAX_PENDING_EXTENSIONS_PER_AGENT = 8;
const MAX_PENDING_EXTENSIONS_GLOBAL = 128;
const MAX_TRANSCRIPT_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_MESSAGE_CHARS = 120_000;
const THINKING_FULL_MAX_CHARS = 16_000;
const PYTHON_CODE_MAX_CHARS = 16_000;
const PYTHON_STDOUT_MAX_CHARS = 6_000;
const PYTHON_STDERR_MAX_CHARS = 4_000;
const PYTHON_RESULT_MAX_CHARS = 4_000;
const PYTHON_TRACEBACK_MAX_CHARS = 6_000;
const PYTHON_DIFF_MAX_COUNT = 10;
const PYTHON_DIFF_SIDE_MAX_CHARS = 4_000;
const CELL_SECTION_MAX_CHARS = 512 * 1024;
const CELL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const REFINE_EDITS_MAX = 10;
const MAX_STORED_REFINES = 20;
const MAX_DASHBOARD_REFINES = 20;
const CONTEXT_STATS_MIN_INTERVAL_MS = 20_000;
const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";
const STABLE_DATE_FALLBACK = "1970-01-01T00:00:00.000Z";
const DIRECT_SLASH_COMMAND_NAME_SET = new Set<string>(DIRECT_SLASH_COMMAND_NAMES);
const EXPLICIT_SLASH_COMMAND_NAMES = new Set<string>([
  ...SESSION_SLASH_COMMAND_NAMES,
  ...DIRECT_SLASH_COMMAND_NAMES,
]);

function safeLabel(value: unknown, fallback: string, maxChars = 120): string {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (label || fallback).slice(0, maxChars);
}

function modelCatalogOptions(models: readonly PrimeModel[], current?: PrimeModel): SlashCommandOption[] {
  const seen = new Set<string>();
  const options: SlashCommandOption[] = [];
  for (const model of models) {
    if (options.length >= 250 || typeof model.provider !== "string" || typeof model.id !== "string") continue;
    const value = `${model.provider}/${model.id}`;
    if (!model.provider || !model.id || value.length > 240 || /[\s\r\n\u2028\u2029]/u.test(value) || seen.has(value)) continue;
    seen.add(value);
    const reference = `${safeLabel(model.provider, "provider", 60)}/${safeLabel(model.id, "model", 120)}`;
    options.push({
      value,
      label: reference,
      ...(current?.provider === model.provider && current.id === model.id ? { current: true } : {}),
    });
  }
  return options.sort((left, right) => Number(Boolean(right.current)) - Number(Boolean(left.current)) || left.label.localeCompare(right.label));
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function projectContextStats(stats: PrimeSessionStats): Extract<SlashCommandResult, { kind: "context_usage" }> {
  return {
    kind: "context_usage",
    ...(numeric(stats.contextUsage?.tokens) !== undefined ? { contextTokens: numeric(stats.contextUsage?.tokens) } : {}),
    ...(numeric(stats.contextUsage?.contextWindow) !== undefined ? { contextWindow: numeric(stats.contextUsage?.contextWindow) } : {}),
    ...(numeric(stats.contextUsage?.percent) !== undefined ? { percent: numeric(stats.contextUsage?.percent) } : {}),
    ...(numeric(stats.tokens?.total) !== undefined ? { totalTokens: numeric(stats.tokens?.total) } : {}),
    ...(numeric(stats.cost) !== undefined ? { cost: numeric(stats.cost) } : {}),
  };
}

function projectHeartbeat(heartbeat: PrimeHeartbeat | undefined): Extract<SlashCommandResult, { kind: "heartbeat" }> {
  if (!heartbeat) return { kind: "heartbeat", status: "none" };
  const allowedStatuses = new Set(["active", "paused", "completed", "cancelled"]);
  const status = typeof heartbeat.status === "string" && allowedStatuses.has(heartbeat.status)
    ? heartbeat.status as "active" | "paused" | "completed" | "cancelled"
    : "unknown";
  const schedule = safeLabel(heartbeat.schedule?.expression, "", 80);
  const nextRunAt = typeof heartbeat.nextRunAt === "string" && !Number.isNaN(Date.parse(heartbeat.nextRunAt))
    ? new Date(heartbeat.nextRunAt).toISOString()
    : undefined;
  return {
    kind: "heartbeat",
    status,
    ...(schedule ? { schedule } : {}),
    ...(heartbeat.deliveryMode === "steer" || heartbeat.deliveryMode === "follow_up"
      ? { deliveryMode: heartbeat.deliveryMode } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  };
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
  images: false,
};

function opaqueId(value: string): string {
  return `agent_${createHash("sha256").update(value).digest("base64url").slice(0, 18)}`;
}

function toIso(value: unknown, fallback = STABLE_DATE_FALLBACK): string {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function boundedString(value: unknown, maxChars: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = value.slice(0, maxChars);
  return allowEmpty || bounded.length > 0 ? bounded : undefined;
}

function boundedId(value: unknown): string | undefined {
  const id = boundedString(value, 512);
  return id && !/[\u0000-\u001f\u007f]/u.test(id) ? id : undefined;
}

function isEmptyStub(summary: PrimeSessionSummary): boolean {
  const firstMessage = typeof summary.firstMessage === "string" ? summary.firstMessage.trim() : "";
  const hasTitle = Boolean(summary.sessionName || summary.summary || (firstMessage && firstMessage !== "(no messages)"));
  if (hasTitle) return false;
  return !summary.activeSessionId || summary.lifecycle === "draft";
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return String(message ?? "").slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
  const record = message as Record<string, unknown>;
  if (typeof record.content === "string") return record.content.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
  if (Array.isArray(record.content)) {
    let text = "";
    for (const part of record.content.slice(0, MAX_MESSAGE_PARTS)) {
      const block = primeRecord(part);
      const value = typeof part === "string"
        ? part
        : block?.type === "text" && typeof block.text === "string"
          ? block.text
          : "";
      text += value.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS - text.length);
      if (text.length >= MAX_TRANSCRIPT_MESSAGE_CHARS) break;
    }
    return text;
  }
  if (typeof record.text === "string") return record.text.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
  if (typeof record.summary === "string") return record.summary.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
  return "";
}

type PrimeRecord = Record<string, unknown>;

const SESSION_SLASH_COMMAND_NAME_SET: ReadonlySet<string> = new Set(SESSION_SLASH_COMMAND_NAMES);

function sessionSlashCommand(record: PrimeRecord): { name: string; text: string } | undefined {
  const details = primeRecord(record.details);
  const command = primeRecord(details?.command);
  const name = command?.name;
  const text = boundedString(command?.text, 4_100, true);
  if (typeof name !== "string" || !SESSION_SLASH_COMMAND_NAME_SET.has(name) || text === undefined) return undefined;
  if ((text !== `/${name}` && !text.startsWith(`/${name} `)) || /[\r\n\u2028\u2029]/u.test(text)) return undefined;
  return { name, text };
}

function primeRecord(value: unknown): PrimeRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PrimeRecord : undefined;
}

function validatePrimeSummary(value: unknown): PrimeSessionSummary | undefined {
  const record = primeRecord(value);
  if (!record) return undefined;
  const id = boundedId(record.id);
  const sessionId = boundedId(record.sessionId);
  if (!id || !sessionId) return undefined;
  const modelRecord = primeRecord(record.model);
  const modelInputs = Array.isArray(modelRecord?.input)
    ? modelRecord.input.slice(0, 20).filter((input): input is string => typeof input === "string" && input.length <= 40)
    : undefined;
  const integer = (input: unknown, maximum: number) => typeof input === "number" && Number.isFinite(input)
    ? Math.min(maximum, Math.max(0, Math.trunc(input)))
    : undefined;
  return {
    id,
    sessionId,
    activeSessionId: boundedId(record.activeSessionId),
    sessionFile: boundedString(record.sessionFile, 4_096),
    sessionName: boundedString(record.sessionName, 200, true),
    lifecycle: boundedString(record.lifecycle, 40),
    activity: boundedString(record.activity, 40),
    runtimeKind: boundedString(record.runtimeKind, 80),
    rlmDepth: integer(record.rlmDepth, 100),
    parentActiveSessionId: boundedId(record.parentActiveSessionId),
    parentSessionId: boundedId(record.parentSessionId),
    isSessionActive: record.isSessionActive === true,
    isStreaming: record.isStreaming === true,
    isCompacting: record.isCompacting === true,
    isBashRunning: record.isBashRunning === true,
    hasRunningRlmChildren: record.hasRunningRlmChildren === true,
    workerState: boundedString(record.workerState, 40),
    taskState: boundedString(record.taskState, 40),
    unfinishedActionCount: integer(record.unfinishedActionCount, 1_000),
    lastActivityAt: boundedString(record.lastActivityAt, 80),
    created: boundedString(record.created, 80),
    modified: boundedString(record.modified, 80),
    summary: boundedString(record.summary, MAX_CATALOG_DESCRIPTION_CHARS, true),
    firstMessage: boundedString(record.firstMessage, 4_000, true),
    cwd: boundedString(record.cwd, MAX_CATALOG_CWD_CHARS),
    ...(modelInputs ? { model: { input: modelInputs } } : {}),
  };
}

function validatePrimeSnapshot(value: unknown): PrimeSnapshot {
  const record = primeRecord(value);
  const state = primeRecord(record?.state);
  const sessionId = boundedId(state?.sessionId);
  if (!record || !state || !sessionId) throw new Error("Prime daemon returned an invalid session snapshot");
  const goalRecord = primeRecord(state.goal);
  const goal = goalRecord ? {
    active: goalRecord.active === true,
    status: boundedString(goalRecord.status, 40),
    objective: boundedString(goalRecord.objective, 4_000, true),
    tokenBudget: numeric(goalRecord.tokenBudget),
    tokensUsed: numeric(goalRecord.tokensUsed),
    timeUsedSeconds: numeric(goalRecord.timeUsedSeconds),
    continuationsUsed: numeric(goalRecord.continuationsUsed),
    updatedAt: numeric(goalRecord.updatedAt),
    lastReason: boundedString(goalRecord.lastReason, 1_000, true),
    lastError: boundedString(goalRecord.lastError, 1_000, true),
  } : undefined;
  const integer = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0
    ? Math.trunc(input)
    : undefined;
  const children = Array.isArray(record.children) ? record.children.slice(0, MAX_SNAPSHOT_CHILDREN).flatMap((value) => {
    const child = primeRecord(value);
    const id = boundedId(child?.id);
    if (!child || !id) return [];
    const activity = primeRecord(child.activity);
    const kind = boundedString(activity?.kind, 40);
    return [{
      id,
      activeSessionId: boundedId(child.activeSessionId),
      label: safeLabel(child.label, "Subagent", 120),
      status: boundedString(child.status, 40) ?? "unknown",
      ...(kind ? { activity: { kind, toolName: boundedString(activity?.toolName, 120) } } : {}),
      durationMs: numeric(child.durationMs),
      answerPreview: boundedString(child.answerPreview, 500),
      toolUseCount: integer(child.toolUseCount),
      tokenCount: integer(child.tokenCount),
      recap: boundedString(child.recap, 500),
      error: boundedString(child.error, 1_000),
    }];
  }) : [];
  return {
    state: {
      sessionId,
      activeSessionId: boundedId(state.activeSessionId),
      sessionName: boundedString(state.sessionName, 200, true),
      isStreaming: state.isStreaming === true,
      isCompacting: state.isCompacting === true,
      isBashRunning: state.isBashRunning === true,
      recap: boundedString(state.recap, 4_000, true),
      goal,
    },
    messages: Array.isArray(record.messages) ? record.messages : [],
    streamingMessage: primeRecord(record.streamingMessage),
    children,
  };
}

type ImageAttachmentSink = (attachment: ValidatedImageAttachment) => void;

function projectImageAttachments(content: unknown, sink?: ImageAttachmentSink): TranscriptAttachment[] {
  if (!Array.isArray(content)) return [];
  const projected: TranscriptAttachment[] = [];
  for (const part of content.slice(0, MAX_MESSAGE_PARTS)) {
    if (projected.length >= MAX_PROJECTED_ATTACHMENTS) break;
    const record = primeRecord(part);
    if (record?.type !== "image") continue;
    try {
      const attachment = validateImageAttachments([record])[0];
      if (!attachment) continue;
      sink?.(attachment);
      projected.push({ id: attachment.id, type: "image", mimeType: attachment.mimeType });
    } catch (error) {
      if (!(error instanceof ImageAttachmentValidationError)) throw error;
      // Invalid persisted image payloads are omitted without exposing their data.
    }
  }
  return projected;
}

function messageIdentity(record: PrimeRecord, index: number, suffix?: string): string {
  const sourceStamp = record.timestamp ?? record.__savedCreatedAt;
  const hasStableStamp = typeof sourceStamp === "string"
    || (typeof sourceStamp === "number" && Number.isFinite(sourceStamp));
  const parsedStamp = typeof sourceStamp === "string" ? Date.parse(sourceStamp) : Number.NaN;
  const stamp = hasStableStamp
    ? (Number.isFinite(parsedStamp) ? parsedStamp : sourceStamp)
    : index;
  const base = typeof record.id === "string"
    ? record.id
    : `${String(record.role)}:${stamp}${hasStableStamp ? "" : `:${index}`}`;
  return opaqueId(suffix ? `${base}:${suffix}` : base);
}

function messageCreatedAt(record: PrimeRecord): string {
  return toIso(record.timestamp ?? record.__savedCreatedAt);
}

function plainMessage(
  record: PrimeRecord,
  index: number,
  role: TranscriptMessage["role"],
  text: string,
  streaming: boolean,
  suffix?: string,
  attachments: TranscriptAttachment[] = [],
): TranscriptMessage | null {
  if (!streaming && !text.trim() && attachments.length === 0) return null;
  return {
    id: messageIdentity(record, index, suffix),
    role,
    text,
    state: streaming ? "streaming" : "complete",
    createdAt: messageCreatedAt(record),
    ...(attachments.length ? { attachments } : {}),
  };
}

function boundedToolCall(call: PrimeRecord): PrimeRecord {
  const argumentsRecord = primeRecord(call.arguments);
  let boundedArguments: PrimeRecord | undefined;
  if (argumentsRecord) {
    for (const key of ["code", "command", "query", "path"] as const) {
      const value = boundedString(argumentsRecord[key], MAX_TRANSCRIPT_MESSAGE_CHARS, true);
      if (value !== undefined) {
        boundedArguments = { [key]: value };
        break;
      }
    }
  }
  return {
    name: boundedString(call.name, 120, true) ?? "tool",
    ...(boundedArguments ? { arguments: boundedArguments } : {}),
  };
}

function boundedToolResult(result: PrimeRecord): PrimeRecord {
  const details = primeRecord(result.details);
  const error = primeRecord(details?.error);
  const boundedDetails: PrimeRecord = {
    status: boundedString(details?.status, 40),
    durationMs: numeric(details?.durationMs),
    stdout: boundedString(details?.stdout, 40_000, true),
    stderr: boundedString(details?.stderr, 40_000, true),
    result: boundedString(details?.result, 40_000, true),
    errorEname: boundedString(details?.errorEname, 80, true),
    ...(error ? { error: { ename: boundedString(error.ename, 80, true) } } : {}),
    ...(Array.isArray(details?.diffs) && details.diffs.length > 0 ? { diffs: [{}] } : {}),
  };
  const content: PrimeRecord[] = [];
  let remaining = MAX_TRANSCRIPT_MESSAGE_CHARS;
  if (Array.isArray(result.content)) {
    for (const rawPart of result.content.slice(0, MAX_MESSAGE_PARTS)) {
      const part = primeRecord(rawPart);
      if (part?.type !== "text" || typeof part.text !== "string" || remaining <= 0) continue;
      const text = part.text.slice(0, remaining);
      content.push({ type: "text", text });
      remaining -= text.length;
    }
  }
  return {
    isError: result.isError === true,
    details: boundedDetails,
    content,
  };
}

type CellSink = (cell: CellOutput) => void;

export function cellOutputId(toolCallId: string): string {
  return `cell_${createHash("sha256").update(`cell:${toolCallId}`).digest("base64url").slice(0, 18)}`;
}

interface CappedSection {
  text: string;
  truncated: boolean;
}

function cappedSection(value: unknown, maxChars: number): CappedSection | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return { text: value.slice(0, maxChars), truncated: value.length > maxChars };
}

function tracebackText(error: PrimeRecord | undefined): string {
  if (Array.isArray(error?.traceback)) {
    return error.traceback.filter((line): line is string => typeof line === "string").join("\n");
  }
  return typeof error?.traceback === "string" ? error.traceback : "";
}

function buildCellOutput(id: string, code: string, details: PrimeRecord | undefined, traceback: string): CellOutput {
  const sections: Array<[keyof CellOutput & string, unknown]> = [
    ["code", code],
    ["stdout", details?.stdout],
    ["stderr", details?.stderr],
    ["result", details?.result],
    ["traceback", traceback],
  ];
  let truncated = false;
  const cell: CellOutput = { cellId: id, truncated: false };
  for (const [key, value] of sections) {
    const section = cappedSection(value, CELL_SECTION_MAX_CHARS);
    if (!section) continue;
    (cell as Record<string, unknown>)[key] = section.text;
    truncated ||= section.truncated;
  }
  cell.truncated = truncated;
  return cell;
}

/** Rich python-cell presentation rendered from raw daemon details (content duplicates skipped). */
function pythonPresentation(
  call: PrimeRecord,
  result: PrimeRecord | undefined,
  summary: { text: string; status: TranscriptToolStatus; meta?: string },
  callId: string | undefined,
  cellSink?: CellSink,
): PythonPresentation {
  const args = primeRecord(call.arguments);
  const rawCode = typeof args?.code === "string" ? args.code : "";
  const bashCell = /^(?:(?:[ \t]*\r?\n)*[ \t]*)%%bash\b/.test(rawCode);
  const details = primeRecord(result?.details);
  const error = primeRecord(details?.error);
  const rawTraceback = tracebackText(error);
  const code = cappedSection(rawCode, PYTHON_CODE_MAX_CHARS);
  const stdout = cappedSection(details?.stdout, PYTHON_STDOUT_MAX_CHARS);
  const stderr = cappedSection(details?.stderr, PYTHON_STDERR_MAX_CHARS);
  const resultSection = cappedSection(details?.result, PYTHON_RESULT_MAX_CHARS);
  const traceback = cappedSection(rawTraceback, PYTHON_TRACEBACK_MAX_CHARS);
  const rawDiffs = Array.isArray(details?.diffs) ? details.diffs : [];
  const diffs = rawDiffs.slice(0, PYTHON_DIFF_MAX_COUNT).flatMap((value) => {
    const diff = primeRecord(value);
    const path = boundedString(diff?.path, 1_024);
    if (!diff || !path) return [];
    const oldStr = typeof diff.oldStr === "string" ? diff.oldStr : "";
    const newStr = typeof diff.newStr === "string" ? diff.newStr : "";
    const startLine = typeof diff.startLine === "number" && Number.isInteger(diff.startLine) && diff.startLine > 0
      ? diff.startLine
      : undefined;
    const truncated = oldStr.length > PYTHON_DIFF_SIDE_MAX_CHARS || newStr.length > PYTHON_DIFF_SIDE_MAX_CHARS;
    return [{
      path,
      oldStr: oldStr.slice(0, PYTHON_DIFF_SIDE_MAX_CHARS),
      newStr: newStr.slice(0, PYTHON_DIFF_SIDE_MAX_CHARS),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(truncated ? { truncated: true } : {}),
    }];
  });
  const ename = boundedString(error?.ename, 120) ?? boundedString(details?.errorEname, 120);
  const evalue = boundedString(error?.evalue, 400);
  const id = callId ? cellOutputId(callId) : undefined;
  if (id && cellSink) cellSink(buildCellOutput(id, rawCode, details, rawTraceback));
  return {
    kind: "python",
    lang: bashCell ? "bash" : "python",
    status: summary.status,
    preview: summary.text,
    ...(summary.meta ? { meta: summary.meta } : {}),
    ...(code ? { code: code.text, ...(code.truncated ? { codeTruncated: true } : {}) } : {}),
    ...(stdout ? { stdout: stdout.text, ...(stdout.truncated ? { stdoutTruncated: true } : {}) } : {}),
    ...(stderr ? { stderr: stderr.text, ...(stderr.truncated ? { stderrTruncated: true } : {}) } : {}),
    ...(resultSection ? { result: resultSection.text, ...(resultSection.truncated ? { resultTruncated: true } : {}) } : {}),
    ...(ename ? {
      error: {
        ename,
        ...(evalue ? { evalue } : {}),
        ...(traceback ? { traceback: traceback.text, ...(traceback.truncated ? { tracebackTruncated: true } : {}) } : {}),
      },
    } : {}),
    ...(diffs.length ? { diffs, ...(rawDiffs.length > PYTHON_DIFF_MAX_COUNT ? { diffsTruncated: true } : {}) } : {}),
    ...(numeric(details?.durationMs) !== undefined ? { durationMs: numeric(details?.durationMs) } : {}),
    ...(details?.kernelRestarted === true ? { kernelRestarted: true } : {}),
    ...(id ? { cellId: id } : {}),
  };
}

const REFINE_EDIT_ACTIONS: readonly RefineEditAction[] = ["create", "update", "delete"];
const REFINE_EDIT_KINDS: readonly RefineEditKind[] = ["prompt", "memory", "skill", "subagent"];

function refineEditAction(value: unknown): RefineEditAction | undefined {
  return REFINE_EDIT_ACTIONS.find((action) => action === value);
}

function refineEditKind(value: unknown): RefineEditKind | undefined {
  return REFINE_EDIT_KINDS.find((kind) => kind === value);
}

/** Bounded refine presentation from a daemon RefinementResult (no before/after entry bodies). */
function refinePresentationFromResult(data: PrimeRecord): RefinePresentation {
  const scope = data.scope === "global" ? "global" as const : data.scope === "local" ? "local" as const : undefined;
  const edits = Array.isArray(data.appliedEdits) ? data.appliedEdits.slice(0, REFINE_EDITS_MAX).flatMap((value) => {
    const edit = primeRecord(value);
    const action = refineEditAction(edit?.action);
    const kind = refineEditKind(edit?.kind);
    if (!edit || !action || !kind) return [];
    const title = boundedString(edit.title, 400);
    const reason = boundedString(edit.reason, 800);
    const error = boundedString(edit.error, 800);
    return [{
      action,
      kind,
      ...(title ? { title: sanitizeTranscriptPreview(title, 120) } : {}),
      ...(reason ? { reason: sanitizeTranscriptPreview(reason, 200) } : {}),
      applied: edit.applied === true,
      ...(error ? { error: sanitizeTranscriptPreview(error, 200) } : {}),
    }];
  }) : [];
  return {
    kind: "refine",
    status: "complete",
    summary: boundedString(data.summary, 1_000) ?? "Refined continual harness state.",
    ...(scope ? { scope } : {}),
    ...(data.rollbackOf ? { rollback: true } : {}),
    ...(edits.length ? { edits } : {}),
  };
}

function assistantErrorRow(record: PrimeRecord, index: number): TranscriptMessage | null {
  if (record.stopReason !== "error") return null;
  const message = boundedString(record.errorMessage, 4_000);
  return {
    id: messageIdentity(record, index, "error"),
    role: "assistant",
    text: message ? sanitizeTranscriptPreview(message, 400) : "The response failed.",
    state: "failed",
    createdAt: messageCreatedAt(record),
    presentation: { kind: "error", label: "Turn failed" },
  };
}

/** Id of the row that opens a turn, when this source record starts one (D1). */
function turnOpenerId(record: PrimeRecord, index: number): string | undefined {
  if (record.role === "user") return messageIdentity(record, index);
  if (record.role === "custom" && record.customType === "session_slash_command" && record.display === true) {
    const command = sessionSlashCommand(record);
    if (command && messageText(record) === command.text) return messageIdentity(record, index, "session-command");
  }
  return undefined;
}

function presentationChars(message: TranscriptMessage): number {
  return message.presentation ? JSON.stringify(message.presentation).length : 0;
}

function messageChars(message: TranscriptMessage): number {
  return message.text.length + presentationChars(message);
}

function refineHistory(messages: readonly TranscriptMessage[]): SessionDashboardRefine[] {
  const rows: SessionDashboardRefine[] = [];
  for (const message of messages) {
    if (message.presentation?.kind !== "refine") continue;
    const presentation = message.presentation;
    rows.push({
      id: message.id,
      status: presentation.status,
      summary: presentation.summary,
      ...(presentation.scope ? { scope: presentation.scope } : {}),
      ...(presentation.rollback ? { rollback: true } : {}),
      createdAt: message.createdAt,
    });
  }
  return rows.slice(-MAX_DASHBOARD_REFINES);
}

/**
 * Enrich the projected /refine outcome rows with the details captured from
 * live refine_complete/refine_failed events, and materialize outcomes that
 * have no slash-command rows (auto-refine applies).
 */
function applyLiveRefines(stored: readonly StoredRefine[], messages: TranscriptMessage[]): void {
  for (const status of ["complete", "failed"] as const) {
    const rows = messages.filter((message) =>
      message.presentation?.kind === "refine" && message.presentation.status === status);
    const records = stored.filter((item) => item.presentation.status === status);
    // Pair from the tail so bounded head-drops on either side cannot skew alignment.
    for (let offset = 1; offset <= Math.min(rows.length, records.length); offset += 1) {
      const row = rows[rows.length - offset]!;
      const record = records[records.length - offset]!;
      row.presentation = record.presentation;
      if (status === "complete") row.text = record.presentation.summary;
    }
    // Outcomes beyond the paired tail (e.g. auto-refine, which writes no slash
    // rows) become their own rows, ordered by their arrival time.
    for (const record of records.slice(0, Math.max(0, records.length - rows.length))) {
      const row: TranscriptMessage = {
        id: opaqueId(`refine:${record.key}`),
        role: "system",
        text: record.presentation.summary,
        state: record.presentation.status === "failed" ? "failed" : "complete",
        createdAt: record.createdAt,
        presentation: record.presentation,
      };
      let position = messages.length;
      while (position > 0 && (messages[position - 1]?.createdAt ?? "") > record.createdAt) position -= 1;
      const previous = messages[position - 1];
      if (previous?.turnId) row.turnId = previous.turnId;
      messages.splice(position, 0, row);
    }
  }
  bracketRunningRefine(messages);
}

/** A trailing /refine command with no outcome row yet shows as an in-progress refine. */
function bracketRunningRefine(messages: TranscriptMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.presentation?.kind === "refine") return;
    if (message.role === "user" && (message.text === "/refine" || message.text.startsWith("/refine "))) {
      messages.push({
        id: opaqueId(`${message.id}:refine-running`),
        role: "system",
        text: "Refine in progress",
        state: "streaming",
        createdAt: message.createdAt,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        presentation: { kind: "refine", status: "running", summary: "Refine in progress" },
      });
      return;
    }
  }
}

function projectMessage(
  message: unknown,
  index: number,
  streaming: boolean,
  toolResults: ReadonlyMap<string, PrimeRecord>,
  imageSink?: ImageAttachmentSink,
  cellSink?: CellSink,
): TranscriptMessage[] {
  const record = primeRecord(message);
  if (!record) return [];
  const rawRole = record.role;

  if (rawRole === "toolResult") return [];
  if (rawRole === "bashExecution") {
    const summary = summarizeBashExecution({
      command: boundedString(record.command, MAX_TRANSCRIPT_MESSAGE_CHARS, true) ?? "",
      output: boundedString(record.output, MAX_TRANSCRIPT_MESSAGE_CHARS, true) ?? "",
      exitCode: record.exitCode,
      cancelled: record.cancelled,
    });
    return [{
      id: messageIdentity(record, index, "bash"),
      role: "system",
      text: summary.text,
      state: summary.status === "failed" ? "failed" : "complete",
      createdAt: messageCreatedAt(record),
      presentation: { kind: "tool", label: summary.label, status: summary.status, meta: summary.meta },
    }];
  }
  if (rawRole === "custom" && record.display !== true) return [];
  if (rawRole === "custom") {
    const command = sessionSlashCommand(record);
    if (record.customType === "session_slash_command" && command && messageText(record) === command.text) {
      const item = plainMessage(record, index, "user", command.text, streaming, "session-command");
      return item ? [item] : [];
    }
    if (record.customType === "session_slash_command_result" && command) {
      const details = primeRecord(record.details);
      const success = details?.success === true;
      const content = success ? messageText(record).slice(0, 4_000) : `/${command.name} failed.`;
      const item = plainMessage(
        record,
        index,
        "system",
        content.trim() || `/${command.name} completed.`,
        streaming,
        "session-command-result",
      );
      if (item && !success) item.state = "failed";
      if (item && command.name === "refine") {
        item.presentation = { kind: "refine", status: success ? "complete" : "failed", summary: item.text };
      }
      return item ? [item] : [];
    }
    if (record.customType === "compaction_outcome") {
      const details = primeRecord(record.details);
      const outcome = details?.outcome;
      const item = plainMessage(record, index, "system", messageText(record), streaming, "notice");
      if (item) {
        item.presentation = {
          kind: "notice",
          label: outcome === "failed" ? "Compaction failed" : outcome === "cancelled" ? "Compaction cancelled" : "Compaction skipped",
          tone: outcome === "failed" ? "danger" : outcome === "cancelled" ? "warning" : "info",
        };
      }
      return item ? [item] : [];
    }
    if (record.customType === "rlm_child_failure" || record.customType === "rlm_child_terminal_notice") {
      const details = primeRecord(record.details);
      const failure = record.customType === "rlm_child_failure";
      const item = plainMessage(record, index, "system", messageText(record), streaming, "notice");
      if (item) {
        item.presentation = {
          kind: "notice",
          label: failure
            ? "Subagent failed"
            : details?.kind === "cancelled" ? "Subagent cancelled" : "Subagent finished without replying",
          tone: failure ? "danger" : "warning",
        };
        if (failure) item.state = "failed";
      }
      return item ? [item] : [];
    }
  }

  if (rawRole === "assistant" && Array.isArray(record.content)) {
    const entries: TranscriptMessage[] = [];
    record.content.slice(0, MAX_MESSAGE_PARTS).forEach((rawPart, partIndex) => {
      if (typeof rawPart === "string") {
        const item = plainMessage(
          record,
          index,
          "assistant",
          rawPart.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS),
          streaming,
          `text:${partIndex}`,
        );
        if (item) entries.push(item);
        return;
      }
      const part = primeRecord(rawPart);
      if (!part) return;
      if (part.type === "text" && typeof part.text === "string") {
        const item = plainMessage(
          record,
          index,
          "assistant",
          part.text.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS),
          streaming,
          `text:${partIndex}`,
        );
        if (item) entries.push(item);
      } else if (part.type === "image") {
        const attachments = projectImageAttachments([part], imageSink);
        const item = plainMessage(record, index, "assistant", "", streaming, `image:${partIndex}`, attachments);
        if (item) entries.push(item);
      } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
        const fullSource = part.thinking.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
        entries.push({
          id: messageIdentity(record, index, `thinking:${partIndex}`),
          role: "assistant",
          text: thinkingRecap(fullSource),
          state: streaming ? "streaming" : "complete",
          createdAt: messageCreatedAt(record),
          presentation: {
            kind: "thinking",
            full: fullSource.slice(0, THINKING_FULL_MAX_CHARS),
            ...(fullSource.length > THINKING_FULL_MAX_CHARS ? { truncated: true } : {}),
          },
        });
      } else if (part.type === "toolCall") {
        const callId = typeof part.id === "string" ? part.id : undefined;
        const result = callId ? toolResults.get(callId) : undefined;
        const summary = summarizeToolCall(
          boundedToolCall(part),
          result ? boundedToolResult(result) : undefined,
          streaming && !result,
        );
        const presentation: TranscriptPresentation = part.name === "ipython"
          ? pythonPresentation(part, result, summary, callId, cellSink)
          : { kind: "tool", label: summary.label, status: summary.status, meta: summary.meta };
        entries.push({
          id: callId ? opaqueId(callId) : messageIdentity(record, index, `tool:${partIndex}`),
          role: "assistant",
          text: summary.text,
          state: summary.status === "failed" ? "failed" : summary.status === "running" ? "streaming" : "complete",
          createdAt: messageCreatedAt(record),
          presentation,
        });
      }
    });
    const errorRow = streaming ? null : assistantErrorRow(record, index);
    if (errorRow) entries.push(errorRow);
    return entries;
  }

  let role: TranscriptMessage["role"];
  if (rawRole === "user" || rawRole === "assistant" || rawRole === "system") role = rawRole;
  else if (rawRole === "custom" || rawRole === "compactionSummary" || rawRole === "branchSummary") role = "system";
  else return [];
  const attachments = projectImageAttachments(record.content, imageSink);
  const item = plainMessage(record, index, role, messageText(record), streaming, undefined, attachments);
  if (item && rawRole === "compactionSummary") {
    item.presentation = { kind: "notice", label: "Context compacted", tone: "info" };
  } else if (item && rawRole === "branchSummary") {
    item.presentation = { kind: "notice", label: "Returned from a branch", tone: "info" };
  }
  const entries = item ? [item] : [];
  const errorRow = rawRole === "assistant" && !streaming ? assistantErrorRow(record, index) : null;
  if (errorRow) entries.push(errorRow);
  return entries;
}

function collectToolResults(messages: readonly unknown[]): Map<string, PrimeRecord> {
  const results = new Map<string, PrimeRecord>();
  for (const message of messages) {
    const record = primeRecord(message);
    if (record?.role === "toolResult" && typeof record.toolCallId === "string") results.set(record.toolCallId, record);
  }
  return results;
}

function ensureUniqueMessageIds(messages: TranscriptMessage[]): TranscriptMessage[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const count = counts.get(message.id) ?? 0;
    counts.set(message.id, count + 1);
    if (count > 0) message.id = opaqueId(`${message.id}:duplicate:${count}`);
  }
  return messages;
}

export function projectPrimeTranscript(
  messages: unknown[],
  streamingMessage?: unknown,
  imageSink?: ImageAttachmentSink,
  cellSink?: CellSink,
): TranscriptMessage[] {
  const boundedSource = messages.slice(-MAX_SNAPSHOT_MESSAGES);
  const sourceOffset = messages.length - boundedSource.length;
  const toolResults = collectToolResults(boundedSource);
  let turnId: string | undefined;
  const projected: TranscriptMessage[] = [];
  const append = (message: unknown, index: number, streaming: boolean): TranscriptMessage[] => {
    const record = primeRecord(message);
    const opener = record ? turnOpenerId(record, index) : undefined;
    if (opener) turnId = opener;
    const rows = projectMessage(message, index, streaming, toolResults, imageSink, cellSink);
    for (const row of rows) {
      if (turnId) row.turnId = turnId;
      projected.push(row);
    }
    return rows;
  };
  boundedSource.forEach((message, index) => append(message, sourceOffset + index, false));
  if (streamingMessage) {
    const streaming = append(streamingMessage, messages.length, true);
    if (!streaming.length) {
      const record = primeRecord(streamingMessage) ?? { role: "assistant" };
      const placeholder = plainMessage(record, messages.length, "assistant", "", true, "placeholder");
      if (placeholder) {
        if (turnId) placeholder.turnId = turnId;
        projected.push(placeholder);
      }
    }
  }
  let totalChars = 0;
  for (const message of projected) {
    message.text = message.text.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
    totalChars += messageChars(message);
  }
  while (projected.length > MAX_SNAPSHOT_MESSAGES || totalChars > MAX_TRANSCRIPT_TEXT_CHARS) {
    const removed = projected.shift();
    totalChars -= removed ? messageChars(removed) : 0;
  }
  return ensureUniqueMessageIds(projected);
}

const SAVED_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const SAVED_TRANSCRIPT_MAX_LINE_CHARS = MAX_IMAGE_REQUEST_BASE64_CHARS + 1024 * 1024;
const SAVED_TRANSCRIPT_MAX_MESSAGES = 1_000;
const SAVED_TRANSCRIPT_MAX_TEXT_CHARS = 2 * 1024 * 1024;
const SAVED_TRANSCRIPT_MAX_MESSAGE_CHARS = 120_000;

function conciseTitle(value: unknown, maxChars = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title || title === "(no messages)") return undefined;
  return title.length > maxChars ? `${title.slice(0, maxChars - 1).trimEnd()}…` : title;
}

/** Project a bounded, compact transcript from a daemon-designated session file. */
export async function projectSavedSessionTranscript(
  sessionFile: string,
  imageSink?: ImageAttachmentSink,
  cellSink?: CellSink,
): Promise<TranscriptMessage[]> {
  try {
    const file = await stat(sessionFile);
    if (!file.isFile() || file.size <= 0) return [];
    const start = Math.max(0, file.size - SAVED_TRANSCRIPT_SCAN_BYTES);
    const stream = createReadStream(sessionFile, { start, end: file.size - 1, highWaterMark: 64 * 1024 });
    const decoder = new StringDecoder("utf8");
    const messages: TranscriptMessage[] = [];
    const savedTools = new Map<string, { call: PrimeRecord; message: TranscriptMessage }>();
    // Successful /refine result rows awaiting their persisted RefinementResult entry.
    const pendingRefines: TranscriptMessage[] = [];
    let totalChars = 0;
    let currentLine = "";
    let droppingLine = false;
    let skipPartialFirstLine = start > 0;
    let index = 0;
    let turnId: string | undefined;

    const appendProjected = (projected: TranscriptMessage) => {
      projected.text = projected.text.slice(0, SAVED_TRANSCRIPT_MAX_MESSAGE_CHARS);
      messages.push(projected);
      totalChars += messageChars(projected);
      while (messages.length > SAVED_TRANSCRIPT_MAX_MESSAGES || totalChars > SAVED_TRANSCRIPT_MAX_TEXT_CHARS) {
        const removed = messages.shift();
        totalChars -= removed ? messageChars(removed) : 0;
      }
    };

    const consumeLine = (line: string) => {
      let entry: PrimeRecord | undefined;
      try {
        entry = primeRecord(JSON.parse(line));
      } catch {
        return;
      }
      if (!entry) return;
      const parsedTimestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp;
      if (entry.type === "custom" && entry.customType === REFINEMENT_CUSTOM_TYPE) {
        const data = primeRecord(entry.data);
        if (data) {
          const presentation = refinePresentationFromResult(data);
          const pending = pendingRefines.shift();
          if (pending) {
            const previous = messageChars(pending);
            pending.presentation = presentation;
            pending.text = presentation.summary;
            if (messages.includes(pending)) totalChars += messageChars(pending) - previous;
          } else {
            appendProjected({
              id: opaqueId(`refine:${typeof data.id === "string" ? data.id : index}`),
              role: "system",
              text: presentation.summary,
              state: "complete",
              createdAt: toIso(entry.timestamp),
              ...(turnId ? { turnId } : {}),
              presentation,
            });
          }
        }
        index += 1;
        return;
      }
      const source = entry.type === "message"
        ? primeRecord(entry.message)
        : entry.type === "compaction" && typeof entry.summary === "string"
          ? { role: "compactionSummary", summary: entry.summary, timestamp: parsedTimestamp }
          : entry.type === "branch_summary" && typeof entry.summary === "string"
            ? { role: "branchSummary", summary: entry.summary, timestamp: parsedTimestamp }
            : entry.type === "custom_message"
              ? {
                  role: "custom",
                  customType: entry.customType,
                  content: entry.content,
                  display: entry.display,
                  details: entry.details,
                  timestamp: parsedTimestamp,
                }
              : undefined;
      if (!source) return;
      const hydrated: PrimeRecord = {
        ...source,
        __savedCreatedAt: entry.timestamp,
      };

      if (hydrated.role === "toolResult" && typeof hydrated.toolCallId === "string") {
        const pending = savedTools.get(hydrated.toolCallId);
        if (pending) {
          const previous = messageChars(pending.message);
          const summary = summarizeToolCall(
            boundedToolCall(pending.call),
            boundedToolResult(hydrated),
            false,
          );
          pending.message.text = summary.text;
          pending.message.state = summary.status === "failed" ? "failed" : "complete";
          pending.message.presentation = pending.call.name === "ipython"
            ? pythonPresentation(pending.call, hydrated, summary, hydrated.toolCallId, cellSink)
            : { kind: "tool", label: summary.label, status: summary.status, meta: summary.meta };
          if (messages.includes(pending.message)) totalChars += messageChars(pending.message) - previous;
          savedTools.delete(hydrated.toolCallId);
        }
        index += 1;
        return;
      }

      const opener = turnOpenerId(hydrated, index);
      if (opener) turnId = opener;
      const projected = projectMessage(hydrated, index, false, new Map(), imageSink, cellSink);
      for (const item of projected) {
        if (turnId) item.turnId = turnId;
        appendProjected(item);
        if (item.presentation?.kind === "refine" && item.presentation.status === "complete") {
          pendingRefines.push(item);
        }
      }
      if (hydrated.role === "assistant" && Array.isArray(hydrated.content)) {
        for (const rawPart of hydrated.content.slice(0, MAX_MESSAGE_PARTS)) {
          const part = primeRecord(rawPart);
          if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
          const callId = part.id;
          const toolMessage = projected.find((item) => item.id === opaqueId(callId));
          if (toolMessage) savedTools.set(callId, { call: part, message: toolMessage });
        }
      }
      index += 1;
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
          if (skipPartialFirstLine) skipPartialFirstLine = false;
          else if (!droppingLine && currentLine.trim()) consumeLine(currentLine);
          currentLine = "";
          droppingLine = false;
        }
      }
      if (final && !droppingLine && currentLine.trim()) consumeLine(currentLine);
    };

    for await (const chunk of stream) consumeChunk(decoder.write(chunk as Buffer));
    consumeChunk(decoder.end(), true);
    for (const pending of savedTools.values()) {
      const presentation = pending.message.presentation;
      if ((presentation?.kind === "tool" || presentation?.kind === "python") && presentation.status === "waiting") {
        pending.message.presentation = { ...presentation, status: "unknown" };
      }
    }
    return ensureUniqueMessageIds(messages);
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

function cellOutputBytes(cell: CellOutput): number {
  return (cell.code?.length ?? 0)
    + (cell.stdout?.length ?? 0)
    + (cell.stderr?.length ?? 0)
    + (cell.result?.length ?? 0)
    + (cell.traceback?.length ?? 0)
    + 64;
}

function dashboardContextUsage(stats: PrimeSessionStats): SessionContextUsage | undefined {
  const usage: SessionContextUsage = {
    ...(numeric(stats.contextUsage?.tokens) !== undefined ? { tokens: numeric(stats.contextUsage?.tokens) } : {}),
    ...(numeric(stats.contextUsage?.contextWindow) !== undefined
      ? { contextWindow: numeric(stats.contextUsage?.contextWindow) }
      : {}),
    ...(numeric(stats.contextUsage?.percent) !== undefined ? { percent: numeric(stats.contextUsage?.percent) } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
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
  private readonly attentionListeners: AttentionListener[] = [];
  private module!: PrimeModule;
  private client!: PrimeDaemonClient;
  private catalogState: CatalogSnapshot = { revision: 0, agents: [] };
  private rawSummaries = new Map<string, PrimeSessionSummary>();
  private publicBySession = new Map<string, string>();
  private publicByActive = new Map<string, string>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly connectionPromises = new Map<string, Promise<ConnectionRecord>>();
  private readonly commandLocks = new Map<string, Promise<void>>();
  private readonly pendingExtensions = new Map<string, PendingExtension>();
  private readonly attachmentCache = new Map<string, AttachmentData>();
  private attachmentCacheBytes = 0;
  private readonly cellCache = new Map<string, CellOutput>();
  private cellCacheBytes = 0;
  private pollTimer?: NodeJS.Timeout;
  private readonly catalogQueue = new CoalescedRefreshQueue({
    run: () => this.loadCatalogOnce(),
    maxBatch: MAX_CATALOG_REFRESH_BATCH,
    delayMs: 0,
    onSuccess: (generation) => this.publishCatalogThrough(generation),
  });
  private catalogPublishGeneration = 0;
  private catalogFingerprint = "";
  private catalogPublishedFingerprint = "";
  // Overridable in tests; production values balance recovery speed and daemon load.
  private catalogPollIntervalMs = 2_000;
  private reconnectDelaysMs: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
  private connectionRefreshRetryDelaysMs: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000];
  private daemonState: "connected" | "reconnecting" = "connected";
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectPromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly moduleSpecifier: string,
    private readonly socketOverride?: string,
  ) {}

  onAttentionAdded(listener: AttentionListener): void {
    this.attentionListeners.push(listener);
  }

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
    this.observeClientDisconnect(this.client);
    await this.refreshCatalog(false);
    this.hub.register("catalog", this.catalogState);
    this.catalogPublishedFingerprint = this.catalogFingerprint;
    // The poll doubles as liveness detection: transitions are logged and drive
    // reconnection instead of logging every failed refresh.
    this.pollTimer = setInterval(() => {
      void this.refreshCatalog(true).then(
        () => this.noteDaemonHealthy(),
        () => this.noteDaemonFailure(),
      );
    }, this.catalogPollIntervalMs);
  }

  private observeClientDisconnect(client: PrimeDaemonClient): void {
    if (typeof client.on !== "function") return;
    const dropped = () => {
      if (!this.closed && this.client === client) this.noteDaemonFailure();
    };
    // Subscribing to "error" also keeps an emitter-based client from crashing
    // the process on an unhandled error event.
    try {
      client.on("close", dropped);
      client.on("error", dropped);
    } catch { /* Emitter surface is optional. */ }
  }

  private noteDaemonFailure(): void {
    if (this.closed || this.daemonState === "reconnecting") return;
    this.daemonState = "reconnecting";
    console.error("Prime daemon connection lost; reconnecting with backoff");
    this.scheduleReconnect();
  }

  private noteDaemonHealthy(): void {
    // Only flip back on our own if no reconnect attempt is mid-flight; an
    // in-flight attempt finishes with a full connection rebuild anyway.
    if (this.closed || this.daemonState !== "reconnecting" || this.reconnectPromise) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.daemonState = "connected";
    this.reconnectAttempt = 0;
    console.error("Prime daemon connection recovered");
    // The outage may have swallowed events; refresh what we still hold.
    for (const record of this.connections.values()) record.refreshQueue.trigger();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.reconnectPromise) return;
    const delays = this.reconnectDelaysMs;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const attempt = this.attemptReconnect();
      this.reconnectPromise = attempt;
      void attempt.catch(() => {}).finally(() => {
        if (this.reconnectPromise === attempt) this.reconnectPromise = undefined;
        if (!this.closed && this.daemonState === "reconnecting") this.scheduleReconnect();
      });
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed || this.daemonState !== "reconnecting") return;
    const replacement = new this.module.DaemonClient(this.socketOverride || this.module.defaultDaemonSocketPath());
    try {
      await replacement.connect(5_000);
      // Prove the socket answers before swapping it in.
      const probe = await replacement.request({ type: "list", all: true });
      if (!probe.success) throw new Error("Prime daemon list failed");
    } catch {
      try { replacement.close(); } catch { /* Best-effort cleanup. */ }
      this.reconnectAttempt += 1;
      return; // The caller reschedules once this attempt settles.
    }
    if (this.closed) {
      try { replacement.close(); } catch { /* Best-effort cleanup. */ }
      return;
    }
    const previous = this.client;
    this.client = replacement;
    this.observeClientDisconnect(replacement);
    try { previous.close(); } catch { /* Best-effort cleanup. */ }
    this.daemonState = "connected";
    this.reconnectAttempt = 0;
    console.error("Prime daemon reconnected");
    // A daemon restart invalidates every attached stream: rebuild the live
    // connections so subscribed clients converge on fresh snapshots.
    const previouslyConnected = [...this.connections.keys()];
    await Promise.allSettled([...this.connections.values()].map((record) => this.disposeConnection(record)));
    try {
      await this.refreshCatalog(true);
    } catch {
      return; // The daemon dropped again immediately; the poll re-detects it.
    }
    await Promise.allSettled(previouslyConnected.map(async (publicId) => {
      const activeSessionId = this.rawSummaries.get(publicId)?.activeSessionId;
      if (activeSessionId) await this.ensureConnection(publicId, activeSessionId);
    }));
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

  attachment(id: string): AttachmentData | null {
    const cached = this.attachmentCache.get(id);
    if (!cached) return null;
    this.attachmentCache.delete(id);
    this.attachmentCache.set(id, cached);
    return cached;
  }

  cellOutput(id: string): CellOutput | null {
    const cached = this.cellCache.get(id);
    if (!cached) return null;
    this.cellCache.delete(id);
    this.cellCache.set(id, cached);
    return structuredClone(cached);
  }

  async sendMessage(input: SendMessageInput): Promise<MutationAccepted> {
    return this.withCommandLock(input.agentId, async () => {
      const snapshot = this.requiredSnapshot(input.agentId);
      if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
      if (input.text.trimStart().startsWith("/")) throw new BackendCapabilityError("Use the session command endpoint");

      const record = await this.resumeConnection(input.agentId);
      const summary = this.rawSummaries.get(input.agentId);
      if (input.images.length > 0 && summary?.model?.input?.includes("image") !== true) {
        throw new BackendCapabilityError("This model does not accept image attachments");
      }
      const images = input.images.map(({ type, mimeType, data }) => ({ type, mimeType, data }));
      try {
        await record.connection.prompt(input.text || "Image attached.", {
          queueIfBusy: true,
          streamingBehavior: "steer",
          images,
        });
      } catch {
        // Do not let daemon/provider errors echo prompt text or image payloads into gateway logs.
        throw new Error("Prime prompt failed");
      }
      for (const image of input.images) this.cacheImage(image);
      return {
        accepted: true,
        requestId: input.requestId,
        revision: this.requiredSnapshot(input.agentId).revision,
      };
    });
  }

  async slashCommandCatalog(agentId: string): Promise<SlashCommandCatalog | null> {
    const summary = this.rawSummaries.get(agentId);
    if (!summary) return null;
    if (!summary.activeSessionId) {
      return {
        agentId,
        agentRevision: this.snapshots.get(agentId)?.revision ?? 1,
        partial: true,
        commands: builtinSlashCommandEntries({
          sessionCommandsAvailable: false,
          supportedDirectCommands: new Set(),
        }),
      };
    }

    const record = await this.ensureConnection(agentId, summary.activeSessionId);
    const connection = record.connection;
    const supported = new Set<typeof DIRECT_SLASH_COMMAND_NAMES[number]>();
    if (typeof connection.getState === "function" && typeof connection.getAvailableModels === "function" && typeof connection.setModel === "function") supported.add("model");
    if (typeof connection.getState === "function" && typeof connection.setThinkingLevel === "function") supported.add("effort");
    if (typeof connection.getState === "function" && typeof connection.setSessionName === "function") supported.add("name");
    if (typeof connection.getSessionStats === "function") supported.add("context");
    if (typeof connection.getHeartbeat === "function" && typeof connection.setHeartbeat === "function" && typeof connection.updateHeartbeat === "function") supported.add("heartbeat");

    let state: PrimeConnectionState = {};
    if (typeof connection.getState === "function") {
      try {
        const current = await connection.getState();
        if (current && typeof current === "object") state = current;
      } catch { /* Catalog remains useful without current values. */ }
    }
    let models: PrimeModel[] = [];
    if (supported.has("model") && typeof connection.getAvailableModels === "function") {
      try {
        const available = await connection.getAvailableModels();
        if (Array.isArray(available)) models = available;
      } catch { /* Omit model options and keep the adapter. */ }
    }
    const effortOptions = (Array.isArray(state.availableThinkingLevels) ? state.availableThinkingLevels : []).slice(0, 12).flatMap((level) => {
      if (typeof level !== "string" || !/^[a-z0-9_-]{1,24}$/i.test(level)) return [];
      return [{ value: level, label: level, ...(level === state.thinkingLevel ? { current: true } : {}) }];
    });
    const heartbeatOptions: SlashCommandOption[] = [
      { value: "status", label: "Show status" },
      { value: "pause", label: "Pause" },
      { value: "resume", label: "Resume" },
      { value: "stop", label: "Stop and clear" },
    ];

    let detected: Array<{ name?: unknown; source?: unknown; [key: string]: unknown }> = [];
    let partial = typeof connection.getCommands !== "function";
    if (typeof connection.getCommands === "function") {
      try {
        const commands = await connection.getCommands();
        if (Array.isArray(commands)) detected = commands;
        else partial = true;
      } catch { partial = true; }
    }
    const builtins = builtinSlashCommandEntries({
      supportedDirectCommands: supported,
      modelOptions: modelCatalogOptions(models, state.model),
      effortOptions,
      heartbeatOptions,
    });
    return {
      agentId,
      agentRevision: this.requiredSnapshot(agentId).revision,
      partial,
      commands: [
        ...builtins,
        ...detectedSlashCommandEntries(detected, EXPLICIT_SLASH_COMMAND_NAMES),
      ],
    };
  }

  async executeSlashCommand(input: ExecuteSlashCommandInput): Promise<SlashCommandAccepted> {
    const record = await this.requiredConnection(input.agentId);
    const snapshot = this.requiredSnapshot(input.agentId);
    if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    const connection = record.connection;

    if (SESSION_SLASH_COMMAND_NAME_SET.has(input.name)) {
      const command = `/${input.name}${input.args ? ` ${input.args}` : ""}`;
      try {
        await connection.prompt(command, { queueIfBusy: true, streamingBehavior: "steer" });
      } catch {
        throw new Error("Prime command failed");
      }
      return {
        accepted: true,
        requestId: input.requestId,
        revision: snapshot.revision,
        result: { kind: "session_accepted" },
      };
    }

    if (!DIRECT_SLASH_COMMAND_NAME_SET.has(input.name)) {
      if (typeof connection.getCommands !== "function") throw new BackendCapabilityError("Command is not available");
      let detected: SlashCommandCatalogEntry[];
      try {
        const commands = await connection.getCommands();
        detected = Array.isArray(commands)
          ? detectedSlashCommandEntries(commands, EXPLICIT_SLASH_COMMAND_NAMES)
          : [];
      } catch {
        throw new Error("Prime experimental command discovery failed");
      }
      const experimental = detected.find((command) => command.name === input.name && command.availability === "experimental");
      if (!experimental || (experimental.source !== "extension" && experimental.source !== "prompt" && experimental.source !== "skill")) {
        throw new BackendCapabilityError("Command is not available");
      }
      const command = `/${input.name}${input.args ? ` ${input.args}` : ""}`;
      try {
        await connection.prompt(command, { queueIfBusy: true, streamingBehavior: "steer" });
      } catch {
        throw new Error("Prime experimental command failed");
      }
      return {
        accepted: true,
        requestId: input.requestId,
        revision: snapshot.revision,
        result: { kind: "experimental_accepted", source: experimental.source },
      };
    }
    return this.withCommandLock(input.agentId, async () => {
      const lockedSnapshot = this.requiredSnapshot(input.agentId);
      if (lockedSnapshot.revision !== input.expectedRevision) {
        throw new BackendConflictError("The agent changed. Refresh and try again.");
      }
      let result: SlashCommandResult;
      let mutated = false;
      try {
      switch (input.name) {
        case "model": {
          if (typeof connection.getState !== "function" || typeof connection.getAvailableModels !== "function" || typeof connection.setModel !== "function") {
            throw new BackendCapabilityError("Model command is unavailable");
          }
          if (!input.args) {
            const model = (await connection.getState()).model;
            const reference = model && typeof model.provider === "string" && typeof model.id === "string"
              ? `${model.provider}/${model.id}`
              : "";
            result = reference && reference.length <= 240 && !/[\s\r\n\u2028\u2029]/u.test(reference)
              ? { kind: "model", provider: model!.provider, modelId: model!.id }
              : { kind: "model" };
            break;
          }
          const available = await connection.getAvailableModels();
          const models = (Array.isArray(available) ? available : []).filter((model) => {
            if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return false;
            const value = `${model.provider}/${model.id}`;
            return value.length <= 240 && !/[\s\r\n\u2028\u2029]/u.test(value);
          });
          const exact = models.filter((model) => `${model.provider}/${model.id}` === input.args);
          const byId = exact.length ? exact : models.filter((model) => model.id === input.args);
          if (byId.length !== 1) throw new BackendCapabilityError("Choose an exact available model");
          const selected = byId[0];
          await connection.setModel(selected.provider, selected.id);
          mutated = true;
          result = { kind: "model", provider: selected.provider, modelId: selected.id };
          break;
        }
        case "effort": {
          if (typeof connection.getState !== "function" || typeof connection.setThinkingLevel !== "function") {
            throw new BackendCapabilityError("Effort command is unavailable");
          }
          let state = await connection.getState();
          const levels = (Array.isArray(state.availableThinkingLevels) ? state.availableThinkingLevels : [])
            .filter((level) => typeof level === "string" && /^[a-z0-9_-]{1,24}$/i.test(level));
          if (input.args) {
            const level = input.args.toLowerCase();
            if (!levels.includes(level)) throw new BackendCapabilityError("Choose an available thinking level");
            await connection.setThinkingLevel(level);
            mutated = true;
            state = { ...state, thinkingLevel: level };
          }
          const currentLevel = typeof state.thinkingLevel === "string" && levels.includes(state.thinkingLevel)
            ? state.thinkingLevel
            : undefined;
          result = { kind: "effort", ...(currentLevel ? { level: currentLevel } : {}), availableLevels: levels.slice(0, 12) };
          break;
        }
        case "name": {
          if (typeof connection.getState !== "function" || typeof connection.setSessionName !== "function") {
            throw new BackendCapabilityError("Name command is unavailable");
          }
          if (input.args) {
            if (input.args.length > 200) throw new BackendCapabilityError("Session name is too long");
            await connection.setSessionName(input.args);
            mutated = true;
            result = { kind: "name", name: input.args };
          } else {
            const name = (await connection.getState()).sessionName;
            result = { kind: "name", ...(name ? { name: safeLabel(name, "", 200) } : {}) };
          }
          break;
        }
        case "context": {
          if (input.args) throw new BackendCapabilityError("Context command does not accept arguments");
          if (typeof connection.getSessionStats !== "function") throw new BackendCapabilityError("Context command is unavailable");
          result = projectContextStats(await connection.getSessionStats());
          break;
        }
        case "heartbeat": {
          if (typeof connection.getHeartbeat !== "function" || typeof connection.setHeartbeat !== "function" || typeof connection.updateHeartbeat !== "function") {
            throw new BackendCapabilityError("Heartbeat command is unavailable");
          }
          const parsed = parseHeartbeatArgs(input.args);
          if (!parsed) throw new BackendCapabilityError("Invalid heartbeat command arguments");
          let heartbeat: PrimeHeartbeat | undefined;
          if (parsed.type === "status") heartbeat = await connection.getHeartbeat();
          else if (parsed.type === "set") {
            heartbeat = await connection.setHeartbeat(parsed.schedule, parsed.instruction, parsed.deliveryMode);
            mutated = true;
          } else {
            const updated = await connection.updateHeartbeat(parsed.type);
            mutated = true;
            heartbeat = parsed.type === "clear" ? undefined : updated;
          }
          result = projectHeartbeat(heartbeat);
          break;
        }
        default:
          throw new BackendCapabilityError("Command is not available");
      }
    } catch (error) {
      if (error instanceof BackendCapabilityError) throw error;
      throw new Error("Prime command failed");
    }
      const revision = mutated ? this.advanceSnapshotRevision(input.agentId) : lockedSnapshot.revision;
      return { accepted: true, requestId: input.requestId, revision, result };
    });
  }

  async abort(input: AbortInput): Promise<MutationAccepted> {
    const record = await this.requiredConnection(input.agentId);
    const snapshot = this.requiredSnapshot(input.agentId);
    if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    await record.connection.abort();
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async rename(input: RenameInput): Promise<MutationAccepted> {
    const summary = this.rawSummaries.get(input.agentId);
    if (!summary) throw new BackendNotFoundError("Agent not found");
    return this.withCommandLock(input.agentId, async () => {
      const snapshot = this.requiredSnapshot(input.agentId);
      if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");

      if (summary.activeSessionId) {
        // A live session is renamed through the same adapter the `/name`
        // command already uses, so the daemon sees one route for one change.
        const record = await this.ensureConnection(input.agentId, summary.activeSessionId);
        const setSessionName = record.connection.setSessionName;
        if (typeof setSessionName !== "function") throw new BackendCapabilityError("This agent cannot be renamed");
        try {
          await setSessionName.call(record.connection, input.name);
        } catch {
          throw new Error("Prime session rename failed");
        }
      } else {
        // A saved session has no connection to carry the change, so the
        // daemon renames the file itself. `sessionPath` is the bounded path
        // this backend already read from the daemon's own listing — never a
        // path the browser chose.
        if (typeof summary.sessionFile !== "string" || !summary.sessionFile) {
          throw new BackendCapabilityError("This agent cannot be renamed");
        }
        let response: PrimeResponse;
        try {
          response = await this.client.request({
            type: "rename_saved_session",
            sessionPath: summary.sessionFile,
            name: input.name,
          });
        } catch {
          throw new Error("Prime session rename failed");
        }
        if (!response.success) throw new Error("Prime session rename failed");
      }

      // The new name reaches the drawer only through a catalog refresh: the
      // name lives on the summary, not in the transcript.
      await this.refreshCatalog(true);
      return {
        accepted: true,
        requestId: input.requestId,
        revision: this.advanceSnapshotRevision(input.agentId),
      };
    });
  }

  async stop(input: StopInput): Promise<MutationAccepted> {
    const summary = this.rawSummaries.get(input.agentId);
    if (!summary) throw new BackendNotFoundError("Agent not found");
    return this.withCommandLock(input.agentId, async () => {
      const snapshot = this.requiredSnapshot(input.agentId);
      if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
      const activeSessionId = summary.activeSessionId;
      if (!activeSessionId) throw new BackendCapabilityError("This agent has no live session to stop");

      // `kill` ends one session, named by its own active id. It is not, and
      // cannot be made into, daemon shutdown.
      let response: PrimeResponse;
      try {
        response = await this.client.request({ type: "kill", activeSessionId });
      } catch {
        throw new Error("Prime session stop failed");
      }
      if (!response.success) throw new Error("Prime session stop failed");

      // The refreshed listing drops the activeSessionId, which is what
      // `reconcileConnections` keys the now-stale connection's disposal off —
      // so the cleanup is this refresh's, not a second step here.
      await this.refreshCatalog(true);
      return {
        accepted: true,
        requestId: input.requestId,
        revision: this.advanceSnapshotRevision(input.agentId),
      };
    });
  }

  async delete(input: DeleteInput): Promise<MutationAccepted> {
    const summary = this.rawSummaries.get(input.agentId);
    if (!summary) throw new BackendNotFoundError("Agent not found");
    return this.withCommandLock(input.agentId, async () => {
      const snapshot = this.requiredSnapshot(input.agentId);
      if (snapshot.revision !== input.expectedRevision) throw new BackendConflictError("The agent changed. Refresh and try again.");
      if (summary.activeSessionId) throw new BackendCapabilityError("Stop this session before deleting it");
      const sessionPath = summary.sessionFile;
      if (typeof sessionPath !== "string" || !sessionPath) {
        throw new BackendCapabilityError("This agent has no saved session to delete");
      }
      // The name the browser believes it is deleting must be the name this
      // session actually has. A catalog that went stale between the
      // confirmation and the request deletes nothing rather than the wrong
      // thing.
      const current = this.catalogState.agents.find((agent) => agent.id === input.agentId);
      if (!current || input.confirmName !== current.name) {
        throw new BackendCapabilityError("That is not this session's name");
      }

      // Read before the removal: there is no snapshot to read afterwards.
      const revision = snapshot.revision + 1;
      let response: PrimeResponse;
      try {
        response = await this.client.request({ type: "delete_saved_session", sessionPath });
      } catch {
        throw new Error("Prime session delete failed");
      }
      if (!response.success) throw new Error("Prime session delete failed");

      this.snapshots.delete(input.agentId);
      this.hub.unregister(`agent:${input.agentId}`);
      await this.refreshCatalog(true);
      return { accepted: true, requestId: input.requestId, revision };
    });
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

    // Claim synchronously before the daemon call. A concurrent retry now sees
    // not-found instead of sending a second response.
    if (!this.removePendingAttention(input.attentionId, pending, true)) {
      throw new BackendNotFoundError("Attention request not found");
    }
    try {
      await pending.connection.respondToExtensionUiRequest(input.attentionId, response);
    } catch {
      throw new Error("Prime attention response failed");
    } finally {
      // A failed refresh must not mask the outcome of the response itself.
      await this.refreshConnection(pending.publicAgentId).catch(() => {});
    }
    const revision = this.requiredSnapshot(pending.publicAgentId).revision;
    return { accepted: true, requestId: input.requestId, revision };
  }

  async listDirectories(requestedPath?: string): Promise<DirectoryListing> {
    const home = homedir();
    const target = absoluteDirectoryPath(requestedPath, home);
    const children: ListedChild[] = [];
    let handle;
    let scannedEntries = 0;
    let scanTruncated = false;
    try {
      handle = await opendir(target);
      for (;;) {
        if (scannedEntries >= DIRECTORY_SCAN_BOUND) {
          scanTruncated = true;
          break;
        }
        let entry;
        try {
          entry = await handle.read();
        } catch {
          break;
        }
        if (!entry) break;
        scannedEntries += 1;
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
    const { entries, truncated } = selectDirectoryEntries(children, scanTruncated);
    return { path: target, home, crumbs: directoryCrumbs(target), entries, truncated };
  }

  async createSession(input: CreateSessionInput): Promise<SessionCreated> {
    if (!path.isAbsolute(input.cwd)) throw new BackendCapabilityError("Working directory must be an absolute path");
    const baseName = input.name?.trim() || path.basename(input.cwd) || "New session";
    const name = uniqueSessionName(baseName, this.catalogState.agents.map((agent) => agent.name));
    let response: PrimeResponse;
    try {
      response = await this.client.request({
        type: "create",
        name,
        config: { cwd: input.cwd },
      });
    } catch {
      throw new BackendNotFoundError("The daemon could not create the session");
    }
    if (!response.success) throw new BackendNotFoundError("The daemon could not create the session");
    const data = primeRecord(response.data);
    const activeSessionId = boundedId(data?.activeSessionId) ?? null;
    const sessionId = boundedId(data?.sessionId) ?? null;
    await this.refreshCatalog(true);
    const publicId = (activeSessionId && this.publicByActive.get(activeSessionId))
      ?? (sessionId && this.publicBySession.get(sessionId))
      ?? null;
    if (!publicId) throw new BackendNotFoundError("The created session did not appear in the catalog");
    await this.agentSnapshot(publicId);
    return { requestId: input.requestId, agentId: publicId };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await Promise.allSettled([
      this.catalogQueue.close(),
      ...(this.reconnectPromise ? [this.reconnectPromise] : []),
      ...this.connectionPromises.values(),
    ]);
    this.connectionPromises.clear();
    for (const pending of this.pendingExtensions.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pendingExtensions.clear();
    await Promise.allSettled([...this.connections.values()].map((record) => this.disposeConnection(record)));
    this.connections.clear();
    this.commandLocks.clear();
    this.attachmentCache.clear();
    this.attachmentCacheBytes = 0;
    this.cellCache.clear();
    this.cellCacheBytes = 0;
    this.client?.close();
  }

  private refreshCatalog(publish: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    const settled = this.catalogQueue.request();
    if (publish) this.catalogPublishGeneration = Math.max(this.catalogPublishGeneration, this.catalogQueue.generation);
    return settled;
  }

  private publishCatalogThrough(generation: number): void {
    if (this.catalogPublishGeneration === 0 || this.catalogPublishGeneration > generation) return;
    if (!this.hub.has("catalog")) return;
    if (this.catalogPublishedFingerprint !== this.catalogFingerprint) {
      this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
      this.catalogPublishedFingerprint = this.catalogFingerprint;
    }
    if (this.catalogPublishGeneration <= generation) this.catalogPublishGeneration = 0;
  }

  private async loadCatalogOnce(): Promise<void> {
    let response: PrimeResponse;
    try {
      response = await this.client.request({ type: "list", all: true });
    } catch {
      throw new Error("Prime daemon list failed");
    }
    if (!response.success) throw new Error("Prime daemon list failed");
    const sessions = primeRecord(response.data)?.sessions;
    if (!Array.isArray(sessions)) throw new Error("Prime daemon returned an invalid session list");
    const summaries: PrimeSessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    for (const value of sessions.slice(0, MAX_CATALOG_SESSIONS)) {
      const summary = validatePrimeSummary(value);
      if (!summary || seenSessionIds.has(summary.sessionId)) continue;
      seenSessionIds.add(summary.sessionId);
      summaries.push(summary);
    }

    const nextPublicBySession = new Map<string, string>();
    const nextPublicByActive = new Map<string, string>();
    for (const summary of summaries) {
      const publicId = opaqueId(summary.sessionId);
      nextPublicBySession.set(summary.sessionId, publicId);
      if (summary.activeSessionId) nextPublicByActive.set(summary.activeSessionId, publicId);
    }
    this.publicBySession = nextPublicBySession;
    this.publicByActive = nextPublicByActive;
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
    const childCounts = new Map<string, number>();
    for (const item of projected) {
      if (item.parentId) childCounts.set(item.parentId, (childCounts.get(item.parentId) ?? 0) + 1);
    }
    for (const item of projected) item.childCount = childCounts.get(item.id) ?? 0;

    const previousSummaries = this.rawSummaries;
    const nextSummaries = new Map(summaries.map((summary) => [opaqueId(summary.sessionId), summary]));
    this.rawSummaries = nextSummaries;
    await this.reconcileConnections(nextSummaries);

    const visibleIds = new Set(projected.map((summary) => summary.id));
    const hiddenConnections = [...this.connections.values()].filter((record) => !visibleIds.has(record.publicId));
    await Promise.allSettled(hiddenConnections.map((record) => this.disposeConnection(record)));
    const previousVisibleIds = new Set(this.catalogState.agents.map((agent) => agent.id));
    for (const previousId of new Set([...previousSummaries.keys(), ...previousVisibleIds])) {
      if (nextSummaries.has(previousId) && visibleIds.has(previousId)) continue;
      this.snapshots.delete(previousId);
      this.clearPendingExtensions(previousId, false);
      if (this.hub.has(`agent:${previousId}`)) this.hub.unregister(`agent:${previousId}`);
    }

    const nextFingerprint = JSON.stringify(projected);
    if (nextFingerprint === this.catalogFingerprint) return;
    this.catalogFingerprint = nextFingerprint;
    this.catalogState = { revision: this.catalogState.revision + 1, agents: projected.filter((agent) => visibleIds.has(agent.id)) };
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
    const attention = pending?.method === "confirm" ? "dialog" as const : pending ? "question" as const : null;
    const needsInput = Boolean(summary.activeSessionId) && summary.taskState === "needs_input";
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
      ...(needsInput ? { needsInput: true } : {}),
      unreadCount: attention ? 1 : 0,
      childCount: 0,
      createdAt: toIso(summary.created || summary.lastActivityAt || summary.modified),
      updatedAt: toIso(summary.lastActivityAt || summary.modified || summary.created),
      capabilities: {
        ...defaultCapabilities,
        send: Boolean(summary.activeSessionId),
        abort: Boolean(summary.activeSessionId && working),
        resume: !summary.activeSessionId && typeof summary.sessionFile === "string" && Boolean(summary.sessionFile),
        // Structural, not probed: capabilities are stamped from the daemon's
        // `list` output with no connection in hand. A live session renames
        // through the adapter, a saved one through its file; whether this
        // build's adapter actually exposes the setter is re-checked at execute
        // time, where a missing one is a refusal rather than a broken button.
        rename: Boolean(summary.activeSessionId) || Boolean(summary.sessionFile),
        // Only a live session has something to end. `kill` takes an
        // activeSessionId, so a saved one has nothing to name.
        stop: Boolean(summary.activeSessionId),
        // The mirror image: `delete_saved_session` deletes a file, so a live
        // session has to be stopped before it can be deleted. That two-step is
        // deliberate — it is one more thing between a phone and an
        // irreversible loss.
        delete: !summary.activeSessionId && Boolean(summary.sessionFile),
        respond: Boolean(summary.activeSessionId),
        images: summary.model?.input?.includes("image") === true,
      },
    };
  }

  private async reconcileConnections(next: ReadonlyMap<string, PrimeSessionSummary>): Promise<void> {
    const stale = [...this.connections.values()].filter((record) =>
      next.get(record.publicId)?.activeSessionId !== record.activeSessionId);
    await Promise.allSettled(stale.map((record) => this.disposeConnection(record)));
  }

  private async ensureConnection(publicId: string, activeSessionId: string): Promise<ConnectionRecord> {
    for (;;) {
      const latestActive = this.rawSummaries.get(publicId)?.activeSessionId;
      if (!latestActive) throw new BackendNotFoundError("Active agent session not found");
      activeSessionId = latestActive;

      const pending = this.connectionPromises.get(publicId);
      if (pending) {
        const resolved = await pending;
        if (!resolved.disposed && resolved.activeSessionId === activeSessionId) return resolved;
        await this.disposeConnection(resolved);
        continue;
      }
      const existing = this.connections.get(publicId);
      if (existing && !existing.disposed && existing.activeSessionId === activeSessionId) return existing;
      if (existing) await this.disposeConnection(existing);

      const created = this.createConnection(publicId, activeSessionId);
      this.connectionPromises.set(publicId, created);
      try {
        const resolved = await created;
        const currentActive = this.rawSummaries.get(publicId)?.activeSessionId;
        if (currentActive === resolved.activeSessionId && !resolved.disposed) return resolved;
        await this.disposeConnection(resolved);
      } finally {
        if (this.connectionPromises.get(publicId) === created) this.connectionPromises.delete(publicId);
      }
    }
  }

  private async createConnection(publicId: string, activeSessionId: string): Promise<ConnectionRecord> {
    const connection = await this.module.DaemonAgentConnection.attach(this.client, activeSessionId, {
      closeClientOnDispose: false,
      supportsExtensionUi: true,
    });
    const buffered: PrimeConnectionEvent[] = [];
    let ready = false;
    const record: ConnectionRecord = {
      publicId,
      activeSessionId,
      connection,
      revision: this.snapshots.get(publicId)?.revision ?? 0,
      disposed: false,
      refines: [],
      unsubscribe: () => {},
      refreshQueue: new CoalescedRefreshQueue({
        run: () => this.runConnectionRefresh(record),
        maxBatch: 4,
        delayMs: 40,
        retryDelaysMs: this.connectionRefreshRetryDelaysMs,
        onFailure: (_error, consecutiveFailures) => {
          if (consecutiveFailures === 1) console.error("Prime agent refresh failed; retrying with backoff");
        },
        onRecovered: () => console.error("Prime agent refresh recovered"),
      }),
    };
    try {
      record.unsubscribe = connection.subscribe((event) => {
        if (record.disposed) return;
        if (!ready) buffered.push(event);
        else this.handleConnectionEvent(record, event);
      });
      this.connections.set(publicId, record);
      const snapshot = validatePrimeSnapshot(await connection.getInitialSnapshot());
      this.applyPrimeSnapshot(record, snapshot, this.hub.has(`agent:${publicId}`));
      ready = true;
      for (const event of buffered) this.handleConnectionEvent(record, event);
      return record;
    } catch (error) {
      await this.disposeConnection(record);
      throw error;
    }
  }

  private handleConnectionEvent(record: ConnectionRecord, event: PrimeConnectionEvent): void {
    if (record.disposed || this.connections.get(record.publicId) !== record) return;
    if (event.type === "extension_ui_request") {
      const request = primeRecord(event.request);
      const requestId = boundedId(request?.id);
      const method = request?.method;
      const rawPayload = primeRecord(request?.payload) ?? {};
      if (requestId && (method === "input" || method === "editor")) {
        void record.connection.respondToExtensionUiRequest(requestId, { cancelled: true }).catch(() =>
          console.error("Could not cancel unsupported Prime text dialog"),
        );
      } else if (requestId && (method === "confirm" || method === "select")) {
        const previous = this.pendingExtensions.get(requestId);
        if (previous) this.cancelPendingAttention(requestId, previous);
        this.makePendingAttentionRoom(record.publicId);
        const payload = this.sanitizeExtensionPayload(rawPayload);
        const revision = (this.snapshots.get(record.publicId)?.revision ?? 0) + 1;
        const pending: PendingExtension = {
          publicAgentId: record.publicId,
          connection: record.connection,
          method,
          payload,
          revision,
          createdAt: new Date().toISOString(),
        };
        const timeout = Number(payload.timeout);
        if (Number.isFinite(timeout) && timeout > 0) {
          pending.timer = setTimeout(() => {
            if (this.pendingExtensions.get(requestId) !== pending) return;
            this.removePendingAttention(requestId, pending, true);
            this.queueConnectionRefresh(record);
          }, Math.min(timeout, 24 * 60 * 60 * 1_000));
        }
        this.pendingExtensions.set(requestId, pending);
        this.publishAttentionAdded(requestId, pending);
      }
    }
    if (event.type === "session_event") {
      const inner = primeRecord(event.event);
      if (inner?.type === "refine_complete") {
        const result = primeRecord(inner.result);
        if (result) {
          this.recordRefine(record, {
            key: boundedId(result.id) ?? `refine-${record.refines.length}`,
            createdAt: new Date().toISOString(),
            presentation: refinePresentationFromResult(result),
          });
        }
      } else if (inner?.type === "refine_failed") {
        const detail = boundedString(inner.error, 800);
        this.recordRefine(record, {
          key: `refine-failed-${record.refines.length}`,
          createdAt: new Date().toISOString(),
          presentation: {
            kind: "refine",
            status: "failed",
            summary: "Refine failed",
            ...(detail ? { error: sanitizeTranscriptPreview(detail, 200) } : {}),
          },
        });
      }
    }
    if (event.type === "closed") {
      this.clearPendingExtensions(record.publicId, true);
      void this.disposeConnection(record).then(
        () => this.refreshCatalog(true).catch(() => console.error("Prime catalog refresh failed after connection close")),
        () => this.refreshCatalog(true).catch(() => console.error("Prime connection cleanup and catalog refresh failed")),
      );
      return;
    }
    this.queueConnectionRefresh(record);
  }

  private queueConnectionRefresh(record: ConnectionRecord): void {
    if (record.disposed || this.connections.get(record.publicId) !== record) return;
    record.refreshQueue.trigger();
  }

  private refreshConnection(publicId: string): Promise<void> {
    const record = this.connections.get(publicId);
    if (!record || record.disposed) return Promise.resolve();
    return record.refreshQueue.request();
  }

  private async runConnectionRefresh(record: ConnectionRecord): Promise<void> {
    if (record.disposed || this.connections.get(record.publicId) !== record) return;
    const snapshot = validatePrimeSnapshot(await record.connection.getInitialSnapshot());
    if (record.disposed || this.connections.get(record.publicId) !== record) return;
    this.applyPrimeSnapshot(record, snapshot, true);
    await this.refreshCatalog(true);
  }

  private applyPrimeSnapshot(record: ConnectionRecord, source: PrimeSnapshot, publish: boolean): void {
    record.revision += 1;
    const messages = projectPrimeTranscript(
      source.messages,
      source.streamingMessage,
      (image) => this.cacheImage(image),
      (cell) => this.cacheCell(cell),
    );
    applyLiveRefines(record.refines, messages);
    const children: SessionDashboardChild[] = (source.children ?? []).map((child) => {
      const agentId = child.activeSessionId ? this.publicByActive.get(child.activeSessionId) : undefined;
      const agentName = agentId ? this.catalogState.agents.find((agent) => agent.id === agentId)?.name : undefined;
      const status = child.status === "queued" || child.status === "running" || child.status === "done"
        || child.status === "error" || child.status === "cancelled"
        ? child.status
        : "unknown";
      return {
        id: `${record.publicId}:child:${opaqueId(child.id)}`,
        ...(agentId ? { agentId } : {}),
        name: agentName ?? sanitizeTranscriptPreview(child.label, 80),
        status,
        ...(child.activity?.toolName ? { toolName: sanitizeTranscriptPreview(child.activity.toolName, 48) } : {}),
        ...(child.durationMs !== undefined ? { durationMs: child.durationMs } : {}),
        ...(child.answerPreview ? { answerPreview: sanitizeTranscriptPreview(child.answerPreview, 200) } : {}),
        ...(child.toolUseCount !== undefined ? { toolUseCount: child.toolUseCount } : {}),
        ...(child.tokenCount !== undefined ? { tokenCount: child.tokenCount } : {}),
        ...(child.recap ? { recap: sanitizeTranscriptPreview(child.recap, 200) } : {}),
        ...(child.error ? { error: sanitizeTranscriptPreview(child.error, 200) } : {}),
      };
    });
    const dashboard: SessionDashboard = {
      status: source.state.isStreaming
        ? "responding"
        : source.state.isCompacting
          ? "compacting"
          : source.state.isBashRunning
            ? "running_command"
            : "idle",
      ...(source.state.recap ? { recap: source.state.recap } : {}),
      needsInput: this.rawSummaries.get(record.publicId)?.taskState === "needs_input",
      ...(record.contextStats?.value ? { contextUsage: record.contextStats.value } : {}),
      children,
      refines: refineHistory(messages),
    };
    const attention = [...this.pendingExtensions.entries()]
      .filter(([, pending]) => pending.publicAgentId === record.publicId)
      .map(([id, pending]) => this.projectAttention(id, pending));
    const snapshot: AgentSnapshot = {
      revision: record.revision,
      agentId: record.publicId,
      messages,
      dashboard,
      attention,
      goal: projectGoal(source.state.goal),
    };
    this.snapshots.set(record.publicId, snapshot);
    const streamId = `agent:${record.publicId}`;
    if (!this.hub.has(streamId)) this.hub.register(streamId, snapshot);
    else if (publish) this.hub.publish(streamId, { kind: "agent.replaced", payload: snapshot }, snapshot);
    this.maybeRefreshContextStats(record);
  }

  private recordRefine(record: ConnectionRecord, refine: StoredRefine): void {
    record.refines.push(refine);
    while (record.refines.length > MAX_STORED_REFINES) record.refines.shift();
  }

  private maybeRefreshContextStats(record: ConnectionRecord): void {
    const connection = record.connection;
    // The connection is dynamically loaded; older daemon builds may lack the method.
    if (typeof connection.getSessionStats !== "function") return;
    if (record.disposed || record.contextStatsPending) return;
    if (record.contextStats && Date.now() - record.contextStats.fetchedAt < CONTEXT_STATS_MIN_INTERVAL_MS) return;
    const stats = connection.getSessionStats;
    const fetching = Promise.resolve()
      .then(() => stats.call(connection))
      .then((value) => {
        record.contextStats = { fetchedAt: Date.now(), value: dashboardContextUsage(value ?? {}) };
        this.applyFetchedContextStats(record);
      })
      .catch(() => {
        // A failed probe stays throttled like a successful one.
        record.contextStats = { fetchedAt: Date.now(), value: record.contextStats?.value };
      })
      .finally(() => {
        if (record.contextStatsPending === fetching) record.contextStatsPending = undefined;
      });
    record.contextStatsPending = fetching;
  }

  private applyFetchedContextStats(record: ConnectionRecord): void {
    if (record.disposed || this.connections.get(record.publicId) !== record) return;
    const snapshot = this.snapshots.get(record.publicId);
    if (!snapshot?.dashboard) return;
    const next = record.contextStats?.value;
    if (JSON.stringify(snapshot.dashboard.contextUsage ?? null) === JSON.stringify(next ?? null)) return;
    if (next) snapshot.dashboard.contextUsage = next;
    else delete snapshot.dashboard.contextUsage;
    snapshot.revision += 1;
    record.revision = Math.max(record.revision, snapshot.revision);
    const streamId = `agent:${record.publicId}`;
    if (this.hub.has(streamId)) this.hub.publish(streamId, { kind: "agent.replaced", payload: snapshot }, snapshot);
  }

  private async disposeConnection(record: ConnectionRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    // Not awaited: an in-flight refresh pass may itself be waiting on a catalog
    // refresh whose batch is what called this disposal.
    void record.refreshQueue.close();
    if (this.connections.get(record.publicId) === record) this.connections.delete(record.publicId);
    this.clearPendingExtensions(record.publicId, true);
    try { record.unsubscribe(); } catch { /* Best-effort listener cleanup. */ }
    try { await record.connection.dispose(); } catch { /* Best-effort adapter cleanup. */ }
  }

  private cacheImage(image: ValidatedImageAttachment): void {
    if (image.bytes.byteLength > ATTACHMENT_CACHE_MAX_BYTES) return;
    const existing = this.attachmentCache.get(image.id);
    if (existing) {
      this.attachmentCacheBytes -= existing.bytes.byteLength;
      this.attachmentCache.delete(image.id);
    }
    this.attachmentCache.set(image.id, { mimeType: image.mimeType, bytes: image.bytes });
    this.attachmentCacheBytes += image.bytes.byteLength;
    while (this.attachmentCacheBytes > ATTACHMENT_CACHE_MAX_BYTES) {
      const oldestId = this.attachmentCache.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.attachmentCache.get(oldestId);
      this.attachmentCache.delete(oldestId);
      this.attachmentCacheBytes -= oldest?.bytes.byteLength ?? 0;
    }
  }

  private cacheCell(cell: CellOutput): void {
    const size = cellOutputBytes(cell);
    if (size > CELL_CACHE_MAX_BYTES) return;
    const existing = this.cellCache.get(cell.cellId);
    if (existing) {
      this.cellCacheBytes -= cellOutputBytes(existing);
      this.cellCache.delete(cell.cellId);
    }
    this.cellCache.set(cell.cellId, cell);
    this.cellCacheBytes += size;
    while (this.cellCacheBytes > CELL_CACHE_MAX_BYTES) {
      const oldestId = this.cellCache.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.cellCache.get(oldestId);
      this.cellCache.delete(oldestId);
      this.cellCacheBytes -= oldest ? cellOutputBytes(oldest) : 0;
    }
  }

  private sanitizeExtensionPayload(payload: PrimeRecord): PrimeRecord {
    const projected: PrimeRecord = {
      title: boundedString(payload.title, 200, true),
      message: boundedString(payload.message, 4_000, true),
    };
    const timeout = numeric(payload.timeout);
    if (timeout !== undefined) projected.timeout = Math.min(timeout, 24 * 60 * 60 * 1_000);
    if (Array.isArray(payload.options)) {
      const options: unknown[] = [];
      for (const value of payload.options.slice(0, 50)) {
        if (typeof value === "string") {
          options.push(value.slice(0, 160));
          continue;
        }
        const option = primeRecord(value);
        if (!option) continue;
        options.push({
          value: boundedString(option.value, 160, true),
          id: boundedString(option.id, 160, true),
          label: boundedString(option.label, 200, true),
        });
      }
      projected.options = options;
    }
    return projected;
  }

  private makePendingAttentionRoom(publicId: string): void {
    for (;;) {
      const perAgent = [...this.pendingExtensions].filter(([, pending]) => pending.publicAgentId === publicId);
      const candidate = perAgent.length >= MAX_PENDING_EXTENSIONS_PER_AGENT
        ? perAgent[0]
        : this.pendingExtensions.size >= MAX_PENDING_EXTENSIONS_GLOBAL
          ? this.pendingExtensions.entries().next().value as [string, PendingExtension] | undefined
          : undefined;
      if (!candidate) return;
      this.cancelPendingAttention(candidate[0], candidate[1]);
    }
  }

  private cancelPendingAttention(id: string, pending: PendingExtension): void {
    if (!this.removePendingAttention(id, pending, true)) return;
    void pending.connection.respondToExtensionUiRequest(id, { cancelled: true }).catch(() =>
      console.error("Could not cancel superseded Prime attention request"),
    );
  }

  private publishAttentionAdded(id: string, pending: PendingExtension): void {
    // Projected unconditionally. The stream publication below is skipped when
    // nobody is attached, but the attention listener must fire either way —
    // "nobody is attached" is the phone-locked case push exists for.
    const attention = this.projectAttention(id, pending);
    const snapshot = this.snapshots.get(pending.publicAgentId);
    if (snapshot) {
      snapshot.attention = [...snapshot.attention.filter((item) => item.id !== id), attention];
      snapshot.revision = Math.max(snapshot.revision + 1, pending.revision);
      pending.revision = snapshot.revision;
      const record = this.connections.get(pending.publicAgentId);
      if (record) record.revision = Math.max(record.revision, snapshot.revision);
      const streamId = `agent:${pending.publicAgentId}`;
      if (this.hub.has(streamId)) {
        this.hub.publish(streamId, { kind: "agent.attention_added", payload: attention }, snapshot);
      }
    }
    this.publishCatalogAttention(pending.publicAgentId);
    // Last, so a listener that reads the catalog sees this request counted.
    for (const listener of this.attentionListeners) {
      try {
        listener(attention);
      } catch (error) {
        // An observer must never break the daemon's attention path.
        console.error("An attention listener failed", error);
      }
    }
  }

  private removePendingAttention(id: string, pending: PendingExtension, publish: boolean): boolean {
    if (this.pendingExtensions.get(id) !== pending) return false;
    this.pendingExtensions.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    const snapshot = this.snapshots.get(pending.publicAgentId);
    const contained = snapshot?.attention.some((item) => item.id === id) === true;
    if (snapshot && contained) {
      snapshot.attention = snapshot.attention.filter((item) => item.id !== id);
      snapshot.revision += 1;
      const record = this.connections.get(pending.publicAgentId);
      if (record) record.revision = Math.max(record.revision, snapshot.revision);
      const streamId = `agent:${pending.publicAgentId}`;
      if (publish && this.hub.has(streamId)) {
        this.hub.publish(streamId, { kind: "agent.attention_resolved", payload: { id } }, snapshot);
      }
    }
    if (publish) this.publishCatalogAttention(pending.publicAgentId);
    return true;
  }

  private publishCatalogAttention(publicId: string): void {
    const current = this.catalogState.agents.find((agent) => agent.id === publicId);
    const raw = this.rawSummaries.get(publicId);
    if (!current || !raw || !this.hub.has("catalog")) return;
    const projected = this.projectSummary(raw);
    if (current.attention === projected.attention
      && current.activity === projected.activity
      && current.unreadCount === projected.unreadCount) return;
    current.attention = projected.attention;
    current.activity = projected.activity;
    current.unreadCount = projected.unreadCount;
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    const fingerprint = JSON.stringify(this.catalogState.agents);
    this.catalogFingerprint = fingerprint;
    this.catalogPublishedFingerprint = fingerprint;
  }

  private clearPendingExtensions(publicId: string, publish = true): void {
    for (const [id, pending] of [...this.pendingExtensions]) {
      if (pending.publicAgentId !== publicId) continue;
      this.removePendingAttention(id, pending, publish);
    }
  }

  private extensionOptions(pending: PendingExtension): AttentionRequest["options"] {
    // Confirm dialogs carry no daemon-provided button labels (title + message
    // only), so the buttons stay neutral instead of inventing approval framing.
    const cancel = { id: "__prime_cancel__", label: pending.method === "confirm" ? "Decline" : "Cancel", tone: "danger" as const };
    if (pending.method === "confirm") {
      return [cancel, { id: "confirm", label: "Confirm", tone: "safe" as const }];
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
      kind: pending.method === "confirm" ? "dialog" : "question",
      title: safeLabel(
        pending.payload.title,
        pending.method === "confirm" ? "Confirmation required" : "Input required",
        200,
      ),
      detail: boundedString(pending.payload.message, 4_000, true),
      revision: pending.revision,
      options,
      createdAt: pending.createdAt,
    };
  }

  private async projectInactiveSnapshot(publicId: string, summary: PrimeSessionSummary): Promise<AgentSnapshot> {
    const messages = summary.sessionFile
      ? await projectSavedSessionTranscript(
          summary.sessionFile,
          (image) => this.cacheImage(image),
          (cell) => this.cacheCell(cell),
        )
      : [];
    const fallback = conciseTitle(summary.firstMessage, 4_000);
    if (!messages.length && fallback) {
      messages.push({ id: `${publicId}:first`, role: "user", text: fallback, state: "complete", createdAt: toIso(summary.created) });
    }
    return {
      revision: 1,
      agentId: publicId,
      messages,
      dashboard: {
        status: "inactive",
        needsInput: false,
        children: [],
        refines: refineHistory(messages),
      },
      attention: [],
    };
  }

  private withCommandLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return withSerialLock(this.commandLocks, agentId, operation);
  }

  private advanceSnapshotRevision(agentId: string): number {
    const snapshot = this.requiredSnapshot(agentId);
    snapshot.revision += 1;
    const record = this.connections.get(agentId);
    if (record) record.revision = Math.max(record.revision, snapshot.revision);
    this.hub.publish(`agent:${agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    return snapshot.revision;
  }

  private async resumeConnection(agentId: string): Promise<ConnectionRecord> {
    const summary = this.rawSummaries.get(agentId);
    if (!summary) throw new BackendNotFoundError("Agent not found");
    if (summary.activeSessionId) return this.ensureConnection(agentId, summary.activeSessionId);
    if (typeof summary.sessionFile !== "string" || !summary.sessionFile) {
      throw new BackendCapabilityError("This agent cannot receive messages");
    }

    let response: PrimeResponse;
    try {
      response = await this.client.request({ type: "create", sessionPath: summary.sessionFile }, 120_000);
    } catch {
      throw new Error("Prime session resume failed");
    }
    if (!response.success) throw new Error("Prime session resume failed");
    const created = (response.data ?? {}) as { sessionId?: unknown };
    if (typeof created.sessionId === "string" && created.sessionId !== summary.sessionId) {
      throw new Error("Prime session resume failed");
    }
    await this.refreshCatalog(true);

    const resumed = this.rawSummaries.get(agentId);
    if (!resumed?.activeSessionId) throw new Error("Prime session resume failed");
    return this.ensureConnection(agentId, resumed.activeSessionId);
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
