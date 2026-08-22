import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export type AgentLifecycle = "starting" | "live" | "inactive" | "stopped" | "failed";
export type AgentActivityState = "working" | "idle" | "blocked";
export type AttentionKind = "approval" | "question" | "error";

export const SESSION_SLASH_COMMAND_NAMES = ["compact", "refine", "goal", "autonomous"] as const;
export type SessionSlashCommandName = typeof SESSION_SLASH_COMMAND_NAMES[number];

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

export const executeSessionSlashCommandRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  name: z.enum(SESSION_SLASH_COMMAND_NAMES),
  args: z.string().trim().max(4_000).refine((value) => !/[\r\n\u2028\u2029]/u.test(value), "Command arguments must be one line"),
}).strict();

export type ExecuteSessionSlashCommandRequest = z.infer<typeof executeSessionSlashCommandRequestSchema>;

export const attentionResponseSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  optionId: z.string().min(1).max(160),
});

export const abortRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
});

export interface MutationAccepted {
  accepted: true;
  requestId: string;
  revision: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface SessionCreated {
  requestId: string;
  agentId: string;
}

export const createSessionRequestSchema = z.object({
  requestId: z.string().uuid(),
  cwd: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(200).optional(),
});

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
}
