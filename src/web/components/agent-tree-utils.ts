import { ANSWERABLE_ATTENTION_LIFECYCLES, type AgentSummary } from "../../protocol";

export interface AgentFamilyRow {
  agent: AgentSummary;
  level: number;
}

export function agentPriority(agent: AgentSummary): number {
  if (agent.attention) return 0;
  if (agent.activity === "working") return 1;
  if (agent.lifecycle === "inactive") return 3;
  return 2;
}

/**
 * Whether this agent is waiting on a person right now.
 *
 * The same rule `attentionAgentCount` counts by, so the attention filter can
 * never show a different number of rows than the chip that opened it. Note
 * what it does NOT consult: `needsInput` is the daemon's advisory guess that a
 * turn may be waiting, and a filter built on a guess hides working sessions
 * for no reason the user can see.
 */
export function needsAttention(agent: AgentSummary): boolean {
  return agent.attention !== null && ANSWERABLE_ATTENTION_LIFECYCLES.includes(agent.lifecycle);
}

/**
 * Grow a set of matching agents into a set that can be drawn as a tree.
 *
 * A match five levels down is unreachable without the rows above it, so every
 * ancestor comes along. Shared by search and by the state filters so the two
 * can be combined without disagreeing about what "still coherent" means.
 */
export function withAncestors(agents: AgentSummary[], matched: ReadonlySet<string>): Set<string> {
  const parents = new Map(agents.map((agent) => [agent.id, agent.parentId]));
  const kept = new Set(matched);
  for (const id of matched) {
    let parent = parents.get(id) ?? null;
    // A cycle would be a daemon bug rather than a shape to trust, so walking
    // stops the moment it revisits a row instead of hanging the drawer.
    while (parent && !kept.has(parent)) {
      kept.add(parent);
      parent = parents.get(parent) ?? null;
    }
  }
  return kept;
}

export function indexChildren(
  agents: AgentSummary[],
  pinnedRoots: ReadonlySet<string> = new Set(),
): Map<string | null, AgentSummary[]> {
  const children = new Map<string | null, AgentSummary[]>();
  for (const agent of agents) {
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }
  for (const [parentId, siblings] of children) {
    // Pins only reorder the top level. A pin is about the session you keep
    // coming back to; inside one, the order that matters is still "who needs
    // me first", and lifting a pinned subagent above an attention would be a
    // preference outranking an alarm.
    const pinFirst = parentId === null && pinnedRoots.size > 0;
    siblings.sort((a, b) =>
      (pinFirst ? Number(pinnedRoots.has(b.id)) - Number(pinnedRoots.has(a.id)) : 0)
      || agentPriority(a) - agentPriority(b)
      || b.updatedAt.localeCompare(a.updatedAt));
  }
  return children;
}

export function collectAgentDescendants(agents: AgentSummary[], parentId: string): AgentSummary[] {
  const children = indexChildren(agents);
  const descendants: AgentSummary[] = [];
  const seen = new Set<string>([parentId]);
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      visit(child.id);
    }
  };
  visit(parentId);
  return descendants;
}

export function buildVisibleAgentDescendants(
  agents: AgentSummary[],
  parentId: string,
  expanded: ReadonlySet<string>,
): AgentFamilyRow[] {
  const children = indexChildren(agents);
  const visible: AgentFamilyRow[] = [];
  const seen = new Set<string>([parentId]);
  const visit = (id: string, level: number) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      visible.push({ agent: child, level });
      if (expanded.has(child.id)) visit(child.id, level + 1);
    }
  };
  visit(parentId, 1);
  return visible;
}

export function buildVisibleAgents(
  agents: AgentSummary[],
  expanded: Set<string>,
  pinnedRoots: ReadonlySet<string> = new Set(),
): AgentSummary[] {
  const byParent = indexChildren(agents, pinnedRoots);

  const output: AgentSummary[] = [];
  const decided = new Set<string>();
  const displayed = new Set<string>();
  const knownIds = new Set(agents.map((item) => item.id));
  const visit = (item: AgentSummary) => {
    if (decided.has(item.id)) return;
    decided.add(item.id);
    displayed.add(item.id);
    output.push(item);
    if (expanded.has(item.id)) for (const child of byParent.get(item.id) ?? []) visit(child);
  };
  for (const root of byParent.get(null) ?? []) visit(root);

  // Fixed-point pass: an agent whose parent chain has a missing or not-yet-decided
  // link (orphaned or newly-arrived) still needs a deterministic spot in the output.
  let progress = true;
  while (progress) {
    progress = false;
    for (const item of agents) {
      if (decided.has(item.id)) continue;
      const parentId = item.parentId;
      const parentMissing = parentId !== null && !knownIds.has(parentId);
      const parentDisplayed = parentId !== null && displayed.has(parentId);
      if (parentMissing || (parentDisplayed && expanded.has(parentId))) {
        visit(item);
        progress = true;
      } else if (parentDisplayed || (parentId !== null && decided.has(parentId))) {
        decided.add(item.id);
        progress = true;
      }
    }
  }

  for (const item of agents) if (!decided.has(item.id)) visit(item);
  return output;
}
