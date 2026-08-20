import type {
  AgentSnapshot,
  CatalogSnapshot,
  MutationAccepted,
} from "../protocol.js";
import type { EventHub } from "./event-hub.js";

export interface SendMessageInput {
  agentId: string;
  requestId: string;
  expectedRevision: number;
  text: string;
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

export class BackendConflictError extends Error {}
export class BackendNotFoundError extends Error {}
export class BackendCapabilityError extends Error {}

export interface AgentBackend {
  readonly kind: "demo" | "prime";
  initialize(hub: EventHub): Promise<void>;
  catalog(): CatalogSnapshot;
  agentSnapshot(agentId: string): Promise<AgentSnapshot | null>;
  sendMessage(input: SendMessageInput): Promise<MutationAccepted>;
  abort(input: AbortInput): Promise<MutationAccepted>;
  resolveAttention(input: ResolveAttentionInput): Promise<MutationAccepted>;
  close(): Promise<void>;
}
