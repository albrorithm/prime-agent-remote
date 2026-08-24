import type { AgentSummary } from "../../protocol";

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

export function indexChildren(agents: AgentSummary[]): Map<string | null, AgentSummary[]> {
  const children = new Map<string | null, AgentSummary[]>();
  for (const agent of agents) {
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => agentPriority(a) - agentPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
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

export function buildVisibleAgents(agents: AgentSummary[], expanded: Set<string>): AgentSummary[] {
  const byParent = indexChildren(agents);

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
