import type {
  AgentSnapshot,
  AgentSummary,
  CatalogSnapshot,
  DirectoryListing,
  ImageMimeType,
  MutationAccepted,
  SessionCreated,
  SessionSlashCommandName,
} from "../protocol.js";
import type { EventHub } from "./event-hub.js";
import type { ValidatedImageAttachment } from "./image-attachments.js";

export interface SendMessageInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
  text: string;
  images: ValidatedImageAttachment[];
}

export interface ExecuteSessionSlashCommandInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
  name: SessionSlashCommandName;
  args: string;
}

export interface AttachmentData {
  mimeType: ImageMimeType;
  bytes: Uint8Array;
}

export interface ResolveAttentionInput {
  attentionId: string;
  requestId: string;
  expectedRevision: number;
  optionId: string;
}

export interface AbortInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
}

export interface CreateSessionInput {
  requestId: string;
  cwd: string;
  name?: string;
}

export class BackendConflictError extends Error {}
export class BackendNotFoundError extends Error {}
export class BackendCapabilityError extends Error {}

export function uniqueSessionName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const trimmed = base.trim();
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${trimmed} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface AgentBackend {
  readonly kind: "demo" | "prime";
  initialize(hub: EventHub): Promise<void>;
  catalog(): CatalogSnapshot;
  agentSnapshot(agentId: string): Promise<AgentSnapshot | null>;
  sendMessage(input: SendMessageInput): Promise<MutationAccepted>;
  executeSessionSlashCommand(input: ExecuteSessionSlashCommandInput): Promise<MutationAccepted>;
  attachment(id: string): AttachmentData | null;
  abort(input: AbortInput): Promise<MutationAccepted>;
  resolveAttention(input: ResolveAttentionInput): Promise<MutationAccepted>;
  listDirectories(path?: string): Promise<DirectoryListing>;
  createSession(input: CreateSessionInput): Promise<SessionCreated>;
  close(): Promise<void>;
}
