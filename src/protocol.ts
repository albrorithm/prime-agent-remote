import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export type AgentLifecycle = "starting" | "live" | "inactive" | "stopped" | "failed";
export type AgentActivityState = "working" | "idle" | "blocked";
export type AttentionKind = "dialog" | "question" | "error";

export const SESSION_SLASH_COMMAND_NAMES = ["compact", "refine", "goal", "autonomous"] as const;
export type SessionSlashCommandName = typeof SESSION_SLASH_COMMAND_NAMES[number];
export const DIRECT_SLASH_COMMAND_NAMES = ["model", "effort", "name", "context", "heartbeat"] as const;
export type DirectSlashCommandName = typeof DIRECT_SLASH_COMMAND_NAMES[number];
export const EXECUTABLE_SLASH_COMMAND_NAMES = [...SESSION_SLASH_COMMAND_NAMES, ...DIRECT_SLASH_COMMAND_NAMES] as const;
export type ExecutableSlashCommandName = typeof EXECUTABLE_SLASH_COMMAND_NAMES[number];

export interface SlashCommandOption {
  value: string;
  label: string;
  current?: boolean;
}

export type SlashCommandAvailability = "available" | "experimental" | "unavailable";
export type SlashCommandSource = "session" | "adapter" | "extension" | "prompt" | "skill";

export interface SlashCommandCatalogEntry {
  name: string;
  description: string;
  argumentHint?: string;
  source: SlashCommandSource;
  availability: SlashCommandAvailability;
  unavailableReason?: "inactive_agent" | "adapter_missing" | "not_supported_on_mobile";
  takesArguments: boolean;
  options?: SlashCommandOption[];
}

export interface SlashCommandCatalog {
  agentId: string;
  agentRevision: number;
  partial: boolean;
  commands: SlashCommandCatalogEntry[];
}

// SlashCommandResult is a discriminated union, so (following the ClientFrame
// precedent below) it is declared as a type derived from its schema rather
// than as a hand-written interface with a parallel schema. See
// `slashCommandResultSchema` further down for the runtime definition.
export type SlashCommandResult = z.infer<typeof slashCommandResultSchema>;

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_IMAGE_ATTACHMENTS = 3;
export const MAX_IMAGE_BASE64_CHARS = Math.floor(4.5 * 1024 * 1024);
export const MAX_IMAGE_REQUEST_BASE64_CHARS = MAX_IMAGE_ATTACHMENTS * MAX_IMAGE_BASE64_CHARS;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

export interface ImageAttachmentInput {
  type: "image";
  mimeType: ImageMimeType;
  data: string;
}

export interface TranscriptAttachment {
  id: string;
  type: "image";
  mimeType: ImageMimeType;
}

export interface AgentCapabilities {
  send: boolean;
  abort: boolean;
  resume: boolean;
  rename: boolean;
  stop: boolean;
  deactivate: boolean;
  delete: boolean;
  respond: boolean;
  images: boolean;
}

export interface AgentSummary {
  id: string;
  rootId: string;
  parentId: string | null;
  depth: number;
  name: string;
  /**
   * What a lock screen may call this session, when `name` may not be said aloud.
   * `name` falls back to the first user message and then to the daemon's recap,
   * both of which are conversation text; `docs/security.md` and
   * `push-payload.ts` state categorically that a notification carries none. So
   * this is drawn only from sources that never are: a name a person typed, and
   * the directory the session runs in. Absent when neither exists.
   */
  notificationLabel?: string;
  description?: string;
  cwd?: string;
  lifecycle: AgentLifecycle;
  activity: AgentActivityState;
  attention: AttentionKind | null;
  /** Advisory daemon guess that the agent may be waiting on the user — never a queue. */
  needsInput?: boolean;
  unreadCount: number;
  childCount: number;
  createdAt: string;
  updatedAt: string;
  capabilities: AgentCapabilities;
}

export interface CatalogSnapshot {
  revision: number;
  agents: AgentSummary[];
}

/**
 * Lifecycles in which a request for attention is still answerable. A stopped,
 * inactive, or failed session can keep a stale `attention` flag, and counting
 * one badges the app icon with work nobody can clear.
 */
export const ANSWERABLE_ATTENTION_LIFECYCLES: readonly AgentLifecycle[] = ["starting", "live"];

/**
 * The one app-wide "needs you" count. Lives here rather than in the web app
 * because the gateway counts it too, when it builds a push payload — the icon
 * badge and the notification must never disagree.
 *
 * Deliberately not a sum of `unreadCount`: both backends derive that as
 * `attention ? 1 : 0`, so summing it is this same number by a longer route,
 * and it would start lying the moment the projection gains real unread counts.
 */
export function attentionAgentCount(agents: readonly AgentSummary[]): number {
  return agents.filter((agent) =>
    agent.attention !== null && ANSWERABLE_ATTENTION_LIFECYCLES.includes(agent.lifecycle)).length;
}

export type MessageRole = "user" | "assistant" | "system";
export type MessageState = "complete" | "streaming" | "failed";
export type ActivityStatus = "running" | "waiting" | "complete" | "failed";

export type TranscriptToolStatus = ActivityStatus | "unknown";

export interface PythonCellDiff {
  path: string;
  oldStr: string;
  newStr: string;
  startLine?: number;
  truncated?: boolean;
}

export interface PythonCellError {
  ename: string;
  evalue?: string;
  traceback?: string;
  tracebackTruncated?: boolean;
}

export type RefineEditAction = "create" | "update" | "delete";
export type RefineEditKind = "prompt" | "memory" | "skill" | "subagent";

export interface RefineEditSummary {
  action: RefineEditAction;
  kind: RefineEditKind;
  title?: string;
  reason?: string;
  applied: boolean;
  error?: string;
}

export type RefineScope = "local" | "global";
export type RefineStatus = "running" | "complete" | "failed";
export type NoticeTone = "info" | "warning" | "danger";
/** Where an inter-agent message came from, relative to the agent reading it. */
export type AgentMessageRelationship = "parent" | "child" | "peer";

export type TranscriptPresentation =
  | { kind: "thinking"; full?: string; truncated?: boolean }
  | { kind: "tool"; label: string; status: TranscriptToolStatus; meta?: string }
  | {
      kind: "python";
      lang: "python" | "bash";
      status: TranscriptToolStatus;
      preview: string;
      meta?: string;
      code?: string;
      codeTruncated?: boolean;
      stdout?: string;
      stdoutTruncated?: boolean;
      stderr?: string;
      stderrTruncated?: boolean;
      result?: string;
      resultTruncated?: boolean;
      error?: PythonCellError;
      diffs?: PythonCellDiff[];
      diffsTruncated?: boolean;
      durationMs?: number;
      kernelRestarted?: boolean;
      /** Fetch the untruncated sections via GET /api/v1/cells/:cellId. */
      cellId?: string;
    }
  | {
      kind: "refine";
      status: RefineStatus;
      summary: string;
      scope?: RefineScope;
      rollback?: boolean;
      edits?: RefineEditSummary[];
      error?: string;
    }
  | { kind: "notice"; label: string; tone: NoticeTone }
  /* An inter-agent message: one agent's text delivered into another's
     transcript. The body stays in TranscriptMessage.text; this carries who it
     came from, which is the part a reader needs before deciding to open it. */
  | { kind: "agent-message"; sender: string; relationship: AgentMessageRelationship }
  | { kind: "error"; label: string };

export interface TranscriptMessage {
  id: string;
  role: MessageRole;
  text: string;
  state: MessageState;
  createdAt: string;
  /**
   * Groups the rows of one exchange. Opens at each user prompt or session
   * slash command and is the opening row's id; rows before the first prompt
   * carry none. Group by consecutive turnId.
   */
  turnId?: string;
  presentation?: TranscriptPresentation;
  attachments?: TranscriptAttachment[];
}

export type SessionDashboardStatus = "responding" | "compacting" | "running_command" | "idle" | "inactive";
export type SessionDashboardChildStatus = "queued" | "running" | "done" | "error" | "cancelled" | "unknown";

export interface SessionDashboardChild {
  id: string;
  /** Public agent id when the child maps to a catalog session. */
  agentId?: string;
  name: string;
  status: SessionDashboardChildStatus;
  toolName?: string;
  durationMs?: number;
  answerPreview?: string;
  toolUseCount?: number;
  tokenCount?: number;
  recap?: string;
  error?: string;
}

export interface SessionContextUsage {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
}

export interface SessionDashboardRefine {
  /** Id of the projected refine transcript row. */
  id: string;
  status: RefineStatus;
  summary: string;
  scope?: RefineScope;
  rollback?: boolean;
  createdAt: string;
}

export interface SessionDashboard {
  status: SessionDashboardStatus;
  recap?: string;
  needsInput: boolean;
  contextUsage?: SessionContextUsage;
  children: SessionDashboardChild[];
  refines: SessionDashboardRefine[];
}

export interface AttentionRequest {
  id: string;
  agentId: string;
  kind: AttentionKind;
  title: string;
  detail?: string;
  revision: number;
  options: Array<{
    id: string;
    label: string;
    tone: "default" | "safe" | "danger";
  }>;
  createdAt: string;
}

export type AgentGoalStatus = "active" | "paused" | "budget_limited" | "complete" | "error";

export interface AgentGoal {
  status: AgentGoalStatus;
  objective: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationsUsed: number;
  updatedAt?: string;
  lastReason?: string;
  lastError?: string;
}

export interface AgentSnapshot {
  revision: number;
  agentId: string;
  messages: TranscriptMessage[];
  dashboard?: SessionDashboard;
  attention: AttentionRequest[];
  goal?: AgentGoal;
}

/**
 * Whether this gateway can push at all. The Settings panel needs to tell an
 * operator who has configured no VAPID keys that push is off, rather than
 * offering a switch that silently does nothing.
 */
export interface WebPushAvailability {
  enabled: boolean;
  /** VAPID application server key, base64url. Public by design; null when off. */
  publicKey: string | null;
}

export interface BootstrapResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  csrfToken: string;
  backend: "demo" | "prime";
  push: WebPushAvailability;
  catalog: CatalogSnapshot;
}

export interface StreamCursor {
  epoch: string;
  seq: number;
}

export type GatewayEvent =
  | { kind: "catalog.replaced"; payload: CatalogSnapshot }
  | { kind: "agent.replaced"; payload: AgentSnapshot }
  | { kind: "agent.message_added"; payload: TranscriptMessage }
  | { kind: "agent.message_updated"; payload: TranscriptMessage }
  | { kind: "agent.attention_added"; payload: AttentionRequest }
  | { kind: "agent.attention_resolved"; payload: { id: string } };

export interface EventEnvelope {
  version: typeof PROTOCOL_VERSION;
  streamId: string;
  epoch: string;
  seq: number;
  emittedAt: string;
  event: GatewayEvent;
}

export type ServerFrame =
  | {
      type: "snapshot";
      version: typeof PROTOCOL_VERSION;
      streamId: string;
      cursor: StreamCursor;
      snapshot: CatalogSnapshot | AgentSnapshot;
    }
  | {
      type: "replay";
      version: typeof PROTOCOL_VERSION;
      streamId: string;
      cursor: StreamCursor;
      events: EventEnvelope[];
    }
  | {
      type: "event";
      version: typeof PROTOCOL_VERSION;
      envelope: EventEnvelope;
    }
  | {
      type: "detached";
      version: typeof PROTOCOL_VERSION;
      streamId: string;
      reason: "stream_gone" | "lagged" | "server_shutdown" | "invalid_cursor";
    }
  | { type: "pong"; version: typeof PROTOCOL_VERSION };

const agentCapabilitiesSchema = z.object({
  send: z.boolean(),
  abort: z.boolean(),
  resume: z.boolean(),
  rename: z.boolean(),
  stop: z.boolean(),
  deactivate: z.boolean(),
  delete: z.boolean(),
  respond: z.boolean(),
  images: z.boolean(),
});

const agentSummarySchema = z.object({
  id: z.string(),
  rootId: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  name: z.string(),
  description: z.string().optional(),
  cwd: z.string().optional(),
  lifecycle: z.enum(["starting", "live", "inactive", "stopped", "failed"]),
  activity: z.enum(["working", "idle", "blocked"]),
  attention: z.enum(["dialog", "question", "error"]).nullable(),
  needsInput: z.boolean().optional(),
  unreadCount: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  capabilities: agentCapabilitiesSchema,
});

export const catalogSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  agents: z.array(agentSummarySchema),
});

const slashCommandOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  current: z.boolean().optional(),
});

const slashCommandCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  source: z.enum(["session", "adapter", "extension", "prompt", "skill"]),
  availability: z.enum(["available", "experimental", "unavailable"]),
  unavailableReason: z.enum(["inactive_agent", "adapter_missing", "not_supported_on_mobile"]).optional(),
  takesArguments: z.boolean(),
  options: z.array(slashCommandOptionSchema).optional(),
});

export const slashCommandCatalogSchema = z.object({
  agentId: z.string(),
  agentRevision: z.number().int().nonnegative(),
  partial: z.boolean(),
  commands: z.array(slashCommandCatalogEntrySchema),
});

const transcriptAttachmentSchema = z.object({
  id: z.string(),
  type: z.literal("image"),
  mimeType: z.enum(IMAGE_MIME_TYPES),
});

const transcriptToolStatusSchema = z.enum(["running", "waiting", "complete", "failed", "unknown"]);

const pythonCellDiffSchema = z.object({
  path: z.string(),
  oldStr: z.string(),
  newStr: z.string(),
  startLine: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
});

const pythonCellErrorSchema = z.object({
  ename: z.string(),
  evalue: z.string().optional(),
  traceback: z.string().optional(),
  tracebackTruncated: z.boolean().optional(),
});

const refineEditSummarySchema = z.object({
  action: z.enum(["create", "update", "delete"]),
  kind: z.enum(["prompt", "memory", "skill", "subagent"]),
  title: z.string().optional(),
  reason: z.string().optional(),
  applied: z.boolean(),
  error: z.string().optional(),
});

const refineStatusSchema = z.enum(["running", "complete", "failed"]);
const refineScopeSchema = z.enum(["local", "global"]);

const transcriptPresentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thinking"), full: z.string().optional(), truncated: z.boolean().optional() }),
  z.object({
    kind: z.literal("tool"),
    label: z.string(),
    status: transcriptToolStatusSchema,
    meta: z.string().optional(),
  }),
  z.object({
    kind: z.literal("python"),
    lang: z.enum(["python", "bash"]),
    status: transcriptToolStatusSchema,
    preview: z.string(),
    meta: z.string().optional(),
    code: z.string().optional(),
    codeTruncated: z.boolean().optional(),
    stdout: z.string().optional(),
    stdoutTruncated: z.boolean().optional(),
    stderr: z.string().optional(),
    stderrTruncated: z.boolean().optional(),
    result: z.string().optional(),
    resultTruncated: z.boolean().optional(),
    error: pythonCellErrorSchema.optional(),
    diffs: z.array(pythonCellDiffSchema).optional(),
    diffsTruncated: z.boolean().optional(),
    durationMs: z.number().nonnegative().optional(),
    kernelRestarted: z.boolean().optional(),
    cellId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("refine"),
    status: refineStatusSchema,
    summary: z.string(),
    scope: refineScopeSchema.optional(),
    rollback: z.boolean().optional(),
    edits: z.array(refineEditSummarySchema).optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal("notice"), label: z.string(), tone: z.enum(["info", "warning", "danger"]) }),
  z.object({
    kind: z.literal("agent-message"),
    sender: z.string(),
    relationship: z.enum(["parent", "child", "peer"]),
  }),
  z.object({ kind: z.literal("error"), label: z.string() }),
]);

const transcriptMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  state: z.enum(["complete", "streaming", "failed"]),
  createdAt: z.string(),
  turnId: z.string().optional(),
  presentation: transcriptPresentationSchema.optional(),
  attachments: z.array(transcriptAttachmentSchema).optional(),
});

const sessionDashboardChildSchema = z.object({
  id: z.string(),
  agentId: z.string().optional(),
  name: z.string(),
  status: z.enum(["queued", "running", "done", "error", "cancelled", "unknown"]),
  toolName: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  answerPreview: z.string().optional(),
  toolUseCount: z.number().int().nonnegative().optional(),
  tokenCount: z.number().int().nonnegative().optional(),
  recap: z.string().optional(),
  error: z.string().optional(),
});

const sessionContextUsageSchema = z.object({
  tokens: z.number().nonnegative().optional(),
  contextWindow: z.number().nonnegative().optional(),
  percent: z.number().nonnegative().optional(),
});

const sessionDashboardRefineSchema = z.object({
  id: z.string(),
  status: refineStatusSchema,
  summary: z.string(),
  scope: refineScopeSchema.optional(),
  rollback: z.boolean().optional(),
  createdAt: z.string(),
});

export const sessionDashboardSchema = z.object({
  status: z.enum(["responding", "compacting", "running_command", "idle", "inactive"]),
  recap: z.string().optional(),
  needsInput: z.boolean(),
  contextUsage: sessionContextUsageSchema.optional(),
  children: z.array(sessionDashboardChildSchema),
  refines: z.array(sessionDashboardRefineSchema),
});

export const cellOutputSchema = z.object({
  cellId: z.string().min(1),
  code: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  result: z.string().optional(),
  traceback: z.string().optional(),
  truncated: z.boolean(),
});

export type CellOutput = z.infer<typeof cellOutputSchema>;

const attentionRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: z.enum(["dialog", "question", "error"]),
  title: z.string(),
  detail: z.string().optional(),
  revision: z.number().int().nonnegative(),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    tone: z.enum(["default", "safe", "danger"]),
  })),
  createdAt: z.string(),
});

const agentGoalSchema = z.object({
  status: z.enum(["active", "paused", "budget_limited", "complete", "error"]),
  objective: z.string(),
  tokenBudget: z.number().optional(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  continuationsUsed: z.number(),
  updatedAt: z.string().optional(),
  lastReason: z.string().optional(),
  lastError: z.string().optional(),
});

export const agentSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  agentId: z.string().min(1),
  messages: z.array(transcriptMessageSchema),
  dashboard: sessionDashboardSchema.optional(),
  attention: z.array(attentionRequestSchema),
  goal: agentGoalSchema.optional(),
});

export const bootstrapResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  csrfToken: z.string(),
  backend: z.enum(["demo", "prime"]),
  push: z.object({ enabled: z.boolean(), publicKey: z.string().nullable() }),
  catalog: catalogSnapshotSchema,
});

const gatewayEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog.replaced"), payload: catalogSnapshotSchema }),
  z.object({ kind: z.literal("agent.replaced"), payload: agentSnapshotSchema }),
  z.object({ kind: z.literal("agent.message_added"), payload: transcriptMessageSchema }),
  z.object({ kind: z.literal("agent.message_updated"), payload: transcriptMessageSchema }),
  z.object({ kind: z.literal("agent.attention_added"), payload: attentionRequestSchema }),
  z.object({
    kind: z.literal("agent.attention_resolved"),
    payload: z.object({ id: z.string() }),
  }),
]);

const streamCursorSchema = z.object({
  epoch: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
});

export const eventEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  streamId: z.string().min(1).max(160),
  epoch: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  emittedAt: z.string(),
  event: gatewayEventSchema,
}).superRefine((value, context) => {
  const isCatalog = value.streamId === "catalog";
  if (isCatalog !== (value.event.kind === "catalog.replaced")
    || (!isCatalog && !value.streamId.startsWith("agent:"))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Event does not match its stream" });
    return;
  }
  const agentId = isCatalog ? null : value.streamId.slice(6);
  if (value.event.kind === "agent.replaced" && value.event.payload.agentId !== agentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent event does not match its stream" });
  }
  if (value.event.kind === "agent.attention_added" && value.event.payload.agentId !== agentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Attention event does not match its stream" });
  }
});

export const serverFrameSchema = z.union([
  z.object({
    type: z.literal("snapshot"),
    version: z.literal(PROTOCOL_VERSION),
    streamId: z.string().min(1).max(160),
    cursor: streamCursorSchema,
    snapshot: z.union([catalogSnapshotSchema, agentSnapshotSchema]),
  }).superRefine((value, context) => {
    if (value.streamId === "catalog" && !("agents" in value.snapshot)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Catalog stream requires a catalog snapshot" });
    }
    if (value.streamId.startsWith("agent:")
      && (!("agentId" in value.snapshot) || value.snapshot.agentId !== value.streamId.slice(6))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent snapshot does not match its stream" });
    }
    if (value.streamId !== "catalog" && !value.streamId.startsWith("agent:")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown snapshot stream" });
    }
  }),
  z.object({
    type: z.literal("replay"),
    version: z.literal(PROTOCOL_VERSION),
    streamId: z.string().min(1).max(160),
    cursor: streamCursorSchema,
    events: z.array(eventEnvelopeSchema),
  }).superRefine((value, context) => {
    if (value.events.some((event) => event.streamId !== value.streamId
      || event.epoch !== value.cursor.epoch
      || event.seq > value.cursor.seq)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Replay contains an event outside its stream cursor" });
    }
  }),
  z.object({
    type: z.literal("event"),
    version: z.literal(PROTOCOL_VERSION),
    envelope: eventEnvelopeSchema,
  }),
  z.object({
    type: z.literal("detached"),
    version: z.literal(PROTOCOL_VERSION),
    streamId: z.string().min(1).max(160),
    reason: z.enum(["stream_gone", "lagged", "server_shutdown", "invalid_cursor"]),
  }),
  z.object({ type: z.literal("pong"), version: z.literal(PROTOCOL_VERSION) }),
]);

export const attachFrameSchema = z.object({
  type: z.literal("attach"),
  version: z.literal(PROTOCOL_VERSION),
  streamId: z.string().min(1).max(160),
  since: z
    .object({
      epoch: z.string().min(1).max(128),
      seq: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});

export const detachFrameSchema = z.object({
  type: z.literal("detach"),
  version: z.literal(PROTOCOL_VERSION),
  streamId: z.string().min(1).max(160),
});

export const clientFrameSchema = z.discriminatedUnion("type", [
  attachFrameSchema,
  detachFrameSchema,
  z.object({ type: z.literal("ping"), version: z.literal(PROTOCOL_VERSION) }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

/**
 * `deviceName` labels the credential this pairing issues so a person can tell
 * one phone from another when revoking. It is cosmetic: the gateway bounds and
 * defaults it, and never trusts it for identity.
 */
export const pairRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(64).optional(),
  token: z.string().min(1).max(512),
});

const imageAttachmentRequestSchema = z.object({
  type: z.literal("image"),
  mimeType: z.enum(IMAGE_MIME_TYPES),
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
}).strict();

export const sendMessageRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  text: z.string().trim().max(100_000),
  images: z.array(imageAttachmentRequestSchema).max(MAX_IMAGE_ATTACHMENTS).default([]),
}).superRefine((value, context) => {
  if (!value.text && value.images.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A message or image is required" });
  }
  if (value.text.startsWith("/")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Slash commands use the command endpoint" });
  }
});

export const slashCommandNameSchema = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/,
  "Invalid command name",
);

export const executeSlashCommandRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  name: slashCommandNameSchema,
  args: z.string().trim().max(4_000).refine((value) => !/[\r\n\u2028\u2029]/u.test(value), "Command arguments must be one line"),
}).strict();

export type ExecuteSlashCommandRequest = z.infer<typeof executeSlashCommandRequestSchema>;

export const attentionResponseSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  optionId: z.string().min(1).max(160),
});

export const abortRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
});

export const MAX_PUSH_ENDPOINT_CHARS = 1024;
export const MAX_PUSH_KEY_CHARS = 256;

/**
 * The browser's PushSubscription, narrowed to the three fields an encrypted
 * send needs. Strict on purpose: `toJSON()` also carries `expirationTime`, and
 * a client that sends more than the gateway asked for should hear about it.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS),
  keys: z.object({
    p256dh: z.string().min(1).max(MAX_PUSH_KEY_CHARS),
    auth: z.string().min(1).max(MAX_PUSH_KEY_CHARS),
  }).strict(),
}).strict();

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const pushSubscribeRequestSchema = z.object({
  requestId: z.string().uuid(),
  subscription: pushSubscriptionSchema,
  /**
   * Also wake this device when an agent finishes its turn, not only when one
   * needs an answer. Per device, and absent means no: turn-end fires far more
   * often, and wanting one is not wanting the other.
   */
  turnEnd: z.boolean().optional(),
}).strict();

export const pushUnsubscribeRequestSchema = z.object({
  requestId: z.string().uuid(),
  endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS),
}).strict();

// Push has no agent and therefore no revision to echo, so it cannot reuse
// mutationAcceptedSchema.
export const pushAcceptedSchema = z.object({
  accepted: z.literal(true),
  requestId: z.string(),
});

export interface PushAccepted {
  accepted: true;
  requestId: string;
}

export const slashCommandResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session_accepted") }),
  z.object({ kind: z.literal("experimental_accepted"), source: z.enum(["extension", "prompt", "skill"]) }),
  z.object({ kind: z.literal("model"), provider: z.string().optional(), modelId: z.string().optional() }),
  z.object({ kind: z.literal("effort"), level: z.string().optional(), availableLevels: z.array(z.string()) }),
  z.object({ kind: z.literal("name"), name: z.string().optional() }),
  z.object({
    kind: z.literal("context_usage"),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    percent: z.number().optional(),
    totalTokens: z.number().optional(),
    cost: z.number().optional(),
  }),
  z.object({
    kind: z.literal("heartbeat"),
    status: z.enum(["none", "active", "paused", "completed", "cancelled", "unknown"]),
    schedule: z.string().optional(),
    deliveryMode: z.enum(["steer", "follow_up"]).optional(),
    nextRunAt: z.string().optional(),
  }),
]);

export const mutationAcceptedSchema = z.object({
  accepted: z.literal(true),
  requestId: z.string(),
  revision: z.number().int().nonnegative(),
});

export interface MutationAccepted {
  accepted: true;
  requestId: string;
  revision: number;
}

export const slashCommandAcceptedSchema = mutationAcceptedSchema.extend({
  result: slashCommandResultSchema,
});

export interface SlashCommandAccepted extends MutationAccepted {
  result: SlashCommandResult;
}

export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  hidden: z.boolean(),
});

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export const directoryListingSchema = z.object({
  path: z.string(),
  home: z.string(),
  crumbs: z.array(directoryEntrySchema),
  entries: z.array(directoryEntrySchema),
  truncated: z.boolean(),
});

export interface DirectoryListing {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

export const sessionCreatedSchema = z.object({
  requestId: z.string(),
  agentId: z.string(),
});

export interface SessionCreated {
  requestId: string;
  agentId: string;
}

export const MAX_SESSION_NAME_CHARS = 200;

/**
 * A session name is a label in a list, not a message: one line, no control
 * characters, and bounded at the same 200 the `/name` adapter already enforces
 * further in. Shared by create and rename so the two cannot drift into
 * accepting different names for the same field.
 */
export const sessionNameSchema = z.string().trim().min(1).max(MAX_SESSION_NAME_CHARS)
  .refine((value) => !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), "Session name must be a single line");

export const createSessionRequestSchema = z.object({
  requestId: z.string().uuid(),
  cwd: z.string().min(1).max(1024),
  name: sessionNameSchema.optional(),
});

export const renameAgentRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  name: sessionNameSchema,
}).strict();

/**
 * Ending one agent's session. Deliberately its own schema rather than a reuse
 * of `abortRequestSchema`: abort interrupts what an agent is doing and leaves
 * it live, stop ends the session itself, and the two should not become
 * interchangeable just because they carry the same two fields today.
 */
export const stopAgentRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

/**
 * Deleting a saved session, transcript and all. Irreversible, and the only
 * operation the gateway offers that destroys something rather than changing
 * it — so it carries the name the caller believes it is deleting, and the
 * backend refuses if that is not the session's current name. A confirmation
 * the browser could skip would not be one.
 *
 * `confirmName` deliberately does not reuse `sessionNameSchema`. That schema
 * governs a name entering the system; this is an echo of one already in it,
 * and the two are not the same constraint. A projected name can legitimately
 * fail the stricter rule — demo's `uniqueSessionName` appends a disambiguating
 * suffix that can carry a 200-character name past the bound — and validating
 * the echo against it would reject the only string that could ever match,
 * leaving a delete control that is offered and can never succeed. The bound
 * here exists to cap the request; the equality check does the real work.
 */
export const deleteAgentRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  confirmName: z.string().min(1).max(4_096),
}).strict();

/**
 * A paired device, as the browser is allowed to see it.
 *
 * Deliberately not `StoredDevice`: that record carries `secretHash`, and the
 * gateway does not hand out even a hash of a credential. What is here is what a
 * person needs to recognise one of their own phones and decide whether it should
 * still be able to come back.
 */
export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  /** True for the device making the request, which revokes itself differently. */
  current: boolean;
}

export interface DeviceListSnapshot {
  devices: DeviceSummary[];
}

export const revokeDeviceRequestSchema = z.object({
  deviceId: z.string().min(1).max(128),
}).strict();

export const deviceSummarySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  createdAt: z.string().min(1).max(64),
  lastSeenAt: z.string().min(1).max(64),
  current: z.boolean(),
});

export const deviceListSnapshotSchema = z.object({
  devices: z.array(deviceSummarySchema).max(256),
});

export const deviceRevokedSchema = z.object({
  revoked: z.boolean(),
  self: z.boolean(),
});

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
});

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
}
