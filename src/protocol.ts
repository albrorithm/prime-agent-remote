import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export type AgentLifecycle = "starting" | "live" | "inactive" | "stopped" | "failed";
export type AgentActivityState = "working" | "idle" | "blocked";
export type AttentionKind = "approval" | "question" | "error";

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
  description?: string;
  cwd?: string;
  lifecycle: AgentLifecycle;
  activity: AgentActivityState;
  attention: AttentionKind | null;
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

export type MessageRole = "user" | "assistant" | "system";
export type MessageState = "complete" | "streaming" | "failed";
export type ActivityStatus = "running" | "waiting" | "complete" | "failed";

export type TranscriptToolStatus = ActivityStatus | "unknown";

export type TranscriptPresentation =
  | { kind: "thinking" }
  | { kind: "tool"; label: string; status: TranscriptToolStatus; meta?: string };

export interface TranscriptMessage {
  id: string;
  role: MessageRole;
  text: string;
  state: MessageState;
  createdAt: string;
  presentation?: TranscriptPresentation;
  attachments?: TranscriptAttachment[];
}

export type ActivityKind = "tool" | "thinking" | "child" | "status";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  status: ActivityStatus;
  createdAt: string;
  agentId?: string;
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
  activity: ActivityItem[];
  attention: AttentionRequest[];
  goal?: AgentGoal;
}

export interface BootstrapResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  csrfToken: string;
  backend: "demo" | "prime";
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
  | { kind: "agent.activity_added"; payload: ActivityItem }
  | { kind: "agent.activity_updated"; payload: ActivityItem }
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
  attention: z.enum(["approval", "question", "error"]).nullable(),
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

const transcriptPresentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thinking") }),
  z.object({
    kind: z.literal("tool"),
    label: z.string(),
    status: z.enum(["running", "waiting", "complete", "failed", "unknown"]),
    meta: z.string().optional(),
  }),
]);

const transcriptMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  state: z.enum(["complete", "streaming", "failed"]),
  createdAt: z.string(),
  presentation: transcriptPresentationSchema.optional(),
  attachments: z.array(transcriptAttachmentSchema).optional(),
});

const activityItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["tool", "thinking", "child", "status"]),
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(["running", "waiting", "complete", "failed"]),
  createdAt: z.string(),
  agentId: z.string().optional(),
});

const attentionRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: z.enum(["approval", "question", "error"]),
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
  activity: z.array(activityItemSchema),
  attention: z.array(attentionRequestSchema),
  goal: agentGoalSchema.optional(),
});

export const bootstrapResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  csrfToken: z.string(),
  backend: z.enum(["demo", "prime"]),
  catalog: catalogSnapshotSchema,
});

const gatewayEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog.replaced"), payload: catalogSnapshotSchema }),
  z.object({ kind: z.literal("agent.replaced"), payload: agentSnapshotSchema }),
  z.object({ kind: z.literal("agent.message_added"), payload: transcriptMessageSchema }),
  z.object({ kind: z.literal("agent.message_updated"), payload: transcriptMessageSchema }),
  z.object({ kind: z.literal("agent.activity_added"), payload: activityItemSchema }),
  z.object({ kind: z.literal("agent.activity_updated"), payload: activityItemSchema }),
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

export const pairRequestSchema = z.object({
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

export const createSessionRequestSchema = z.object({
  requestId: z.string().uuid(),
  cwd: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(200).optional(),
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
