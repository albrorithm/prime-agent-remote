import type { AgentSummary, AttentionKind } from "../../protocol";

export type AgentStatusTone = "attention" | "failed" | "stopped" | "inactive" | "starting" | "working" | "blocked" | "idle";

export interface AgentStatus {
  label: string;
  tone: AgentStatusTone;
}

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  dialog: "Needs response",
  question: "Needs input",
  error: "Needs attention",
};

/**
 * Give lifecycle states priority over activity states so a failed, stopped, or
 * starting agent is never announced as idle. Attention still takes priority
 * because it requires an immediate user action.
 */
export function agentStatus(agent: AgentSummary): AgentStatus {
  if (agent.attention) return { label: ATTENTION_LABELS[agent.attention], tone: "attention" };
  if (agent.lifecycle === "failed") return { label: "Failed", tone: "failed" };
  if (agent.lifecycle === "stopped") return { label: "Stopped", tone: "stopped" };
  if (agent.lifecycle === "inactive") return { label: "Inactive", tone: "inactive" };
  if (agent.lifecycle === "starting") return { label: "Starting", tone: "starting" };
  if (agent.activity === "working") return { label: "Working", tone: "working" };
  if (agent.activity === "blocked") return { label: "Blocked", tone: "blocked" };
  return { label: "Idle", tone: "idle" };
}
