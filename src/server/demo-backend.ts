import { randomUUID } from "node:crypto";
import path from "node:path";
import { SESSION_SLASH_COMMAND_NAMES, sessionNameSchema } from "../protocol.js";
import type {
  AgentCapabilities,
  AgentSnapshot,
  AgentSummary,
  AttentionRequest,
  CatalogSnapshot,
  CellOutput,
  DirectoryListing,
  MutationAccepted,
  SessionCreated,
  SessionDashboard,
  SessionDashboardChild,
  SessionDashboardRefine,
  SlashCommandAccepted,
  SlashCommandCatalog,
  SlashCommandResult,
  TranscriptMessage,
} from "../protocol.js";
import {
  BackendCapabilityError,
  BackendConflictError,
  BackendNotFoundError,
  uniqueSessionName,
  withSerialLock,
  type AttachmentData,
  type AbortInput,
  type AgentBackend,
  type CreateSessionInput,
  type ExecuteSlashCommandInput,
  type DeleteInput,
  type RenameInput,
  type StopInput,
  type ResolveAttentionInput,
  type SendMessageInput,
} from "./backend.js";
import { absoluteDirectoryPath, directoryCrumbs, selectDirectoryEntries, type ListedChild } from "./directories.js";
import type { EventHub } from "./event-hub.js";
import { builtinSlashCommandEntries, detectedSlashCommandEntries, parseHeartbeatArgs } from "./slash-command-catalog.js";

const now = new Date().toISOString();
const NOW_MS = Date.parse(now);
/** Deterministic, past-anchored timestamp for seeded demo fixtures — the old activity pane's sin was stamping everything "now". */
function minutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

const DEMO_MAX_AGENTS = 128;
const DEMO_MAX_TRANSCRIPT_MESSAGES = 256;
const DEMO_MAX_TRANSCRIPT_TEXT_CHARS = 2 * 1024 * 1024;
// Two intentional divergences from the live Prime adapter: demo always reports
// images: false, and the /model and /effort slash-command options are
// hardcoded here rather than derived from a provider.
//
// Every other bit states what this backend actually implements. A capability
// advertised but unimplemented is worse than an absent one: the UI reads these
// bits to decide what to offer, so a `true` here puts a control on screen that
// fails when pressed — and it fails only in demo mode, which is the default.
const fullCapabilities: AgentCapabilities = {
  send: true,
  abort: true,
  resume: false,
  rename: true,
  stop: true,
  deactivate: false,
  delete: false,
  respond: true,
  images: false,
};

/**
 * What a session looks like once it has no live session behind it — whether it
 * arrived that way or was stopped. Named once so the seeded fixture and `stop`
 * cannot drift into describing the same state differently.
 */
const inactiveCapabilities: AgentCapabilities = {
  ...fullCapabilities,
  send: false,
  abort: false,
  resume: true,
  respond: false,
  stop: false,
  // Only a saved session can be deleted: the daemon's verb is
  // `delete_saved_session`, and a live one has to be stopped first.
  delete: true,
};

function agent(
  input: Partial<AgentSummary> & Pick<AgentSummary, "id" | "rootId" | "parentId" | "depth" | "name">,
): AgentSummary {
  return {
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: now,
    updatedAt: now,
    capabilities: fullCapabilities,
    /* Safe to mirror `name` here only because every demo name is fixture text
       written into this file. The live backend must not do this: there, a name
       can be the first user message. */
    notificationLabel: input.name,
    ...input,
  };
}

const initialAgents: AgentSummary[] = [
  agent({
    id: "root-mobile",
    rootId: "root-mobile",
    parentId: null,
    depth: 0,
    name: "Mobile WebUI",
    description: "Building the first-party mobile experience",
    cwd: "/projects/mobile-ui",
    activity: "working",
    childCount: 2,
  }),
  agent({
    id: "child-protocol",
    rootId: "root-mobile",
    parentId: "root-mobile",
    depth: 1,
    name: "Protocol designer",
    description: "Testing snapshot and replay semantics",
    activity: "working",
    needsInput: true,
  }),
  agent({
    id: "child-review",
    rootId: "root-mobile",
    parentId: "root-mobile",
    depth: 1,
    name: "Security reviewer",
    description: "Waiting for a dialog response",
    activity: "blocked",
    attention: "dialog",
    unreadCount: 1,
  }),
  agent({
    id: "root-research",
    rootId: "root-research",
    parentId: null,
    depth: 0,
    name: "Research archive",
    description: "Completed UI source audit",
    cwd: "/projects/prime-agent",
    activity: "idle",
  }),
  agent({
    id: "root-inactive",
    rootId: "root-inactive",
    parentId: null,
    depth: 0,
    name: "Previous session",
    description: "Available to resume",
    lifecycle: "inactive",
    activity: "idle",
    capabilities: inactiveCapabilities,
  }),
];

// Full (untruncated) sections for the one demo cell that ships with truncated
// flags, served back by `cellOutput` the way GET /api/v1/cells/:cellId serves
// the live Prime adapter's cache.
const BUDGET_AUDIT_CELL_ID = "cell_demo_budget_audit";
const BUDGET_AUDIT_FULL_CODE = `import json
from pathlib import Path

def audit_transcript_budget(path="session.jsonl"):
    total_chars = 0
    kinds: dict[str, int] = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        kind = entry.get("type", "unknown")
        kinds[kind] = kinds.get(kind, 0) + 1
        total_chars += len(line)
    return {
        "total_chars": total_chars,
        "by_kind": kinds,
        "over_budget": total_chars > 2 * 1024 * 1024,
    }

audit_transcript_budget()`;
const BUDGET_AUDIT_FULL_STDOUT = `Scanned 4,812 transcript lines across 6 sessions.
Largest single message: 38,201 chars (assistant/text).
prime-agent.refinement entries: 3
custom notices: 5`;
const BUDGET_AUDIT_FULL_RESULT = "{'total_chars': 1893440, 'by_kind': {'message': 4021, 'custom': 12, 'compaction': 2}, 'over_budget': False}";

const budgetAuditCellOutput: CellOutput = {
  cellId: BUDGET_AUDIT_CELL_ID,
  code: BUDGET_AUDIT_FULL_CODE,
  stdout: BUDGET_AUDIT_FULL_STDOUT,
  result: BUDGET_AUDIT_FULL_RESULT,
  truncated: false,
};

/**
 * The primary demo transcript: several settled turns (including one opened by
 * a session slash command) plus one live streaming turn, exercising every
 * TranscriptPresentation kind the protocol declares.
 */
function buildMobileTranscript(): TranscriptMessage[] {
  return [
    // Turn A (settled): thinking + a successful python cell.
    {
      id: "mobile-a-user",
      role: "user",
      text: "Add a syntax-highlighted view for the python cells in the transcript, and separate stdout from the return value so we're not guessing which is which.",
      state: "complete",
      createdAt: minutesAgo(58),
      turnId: "mobile-a-user",
    },
    {
      id: "mobile-a-thinking",
      role: "assistant",
      text: "Deciding how to separate stdout from the return value in the cell renderer",
      state: "complete",
      createdAt: minutesAgo(57),
      turnId: "mobile-a-user",
      presentation: {
        kind: "thinking",
        full: "The cell currently mashes stdout and the return value together in one preview string. If I split them into their own labeled sections, the diff view stays legible even when a script prints progress lines before returning a dict. I'll reuse the existing code-block renderer and just feed it the code fence — no need for a bespoke highlighter.",
      },
    },
    {
      id: "mobile-a-cell",
      role: "assistant",
      text: "render_python_cell(cell)",
      state: "complete",
      createdAt: minutesAgo(57),
      turnId: "mobile-a-user",
      presentation: {
        kind: "python",
        lang: "python",
        status: "complete",
        preview: "render_python_cell(cell)",
        meta: "↑ 6 ↓ 2 lines · 420ms",
        code: `def render_python_cell(cell):
    highlighted = highlight(cell.code, "python")
    return f"<pre>{highlighted}</pre>"

render_python_cell(cell)`,
        stdout: "Rendered 1 cell\n",
        result: "'<pre><span class=\"hljs-keyword\">def</span> render_python_cell...</pre>'",
        durationMs: 420,
      },
    },
    {
      id: "mobile-a-answer",
      role: "assistant",
      text: "Added a syntax-highlighted renderer for python cells — code now renders through the same highlighter as prose fences, and stdout is kept in its own section apart from the return value so the two aren't run together.",
      state: "complete",
      createdAt: minutesAgo(56),
      turnId: "mobile-a-user",
    },

    // Turn B (settled, opened by a session slash command): a completed /refine.
    {
      id: "mobile-b-refine-cmd",
      role: "user",
      text: "/refine",
      state: "complete",
      createdAt: minutesAgo(51),
      turnId: "mobile-b-refine-cmd",
    },
    {
      id: "mobile-b-refine-result",
      role: "system",
      text: "Tightened prompt guidance for python-cell previews and added a skill note about diff rendering.",
      state: "complete",
      createdAt: minutesAgo(50),
      turnId: "mobile-b-refine-cmd",
      presentation: {
        kind: "refine",
        status: "complete",
        summary: "Tightened prompt guidance for python-cell previews and added a skill note about diff rendering.",
        scope: "local",
        edits: [
          {
            action: "update",
            kind: "prompt",
            title: "python cell preview rules",
            reason: "Clarify when to prefer the return value over stdout in the one-line preview.",
            applied: true,
          },
          {
            action: "create",
            kind: "skill",
            title: "unified-diff rendering",
            reason: "Document the diff format contract so review tooling stays in sync.",
            applied: true,
          },
          {
            action: "update",
            kind: "memory",
            title: "transcript truncation caps",
            reason: "Record the 16k code / 6k stdout caps for future refines.",
            applied: false,
            error: "Memory file was locked by a concurrent refine.",
          },
        ],
      },
    },

    // Turn B2 (settled, slash-command opened): a failed /refine.
    {
      id: "mobile-b2-refine-cmd",
      role: "user",
      text: "/refine",
      state: "complete",
      createdAt: minutesAgo(48),
      turnId: "mobile-b2-refine-cmd",
    },
    {
      id: "mobile-b2-refine-result",
      role: "system",
      text: "Refine failed",
      state: "failed",
      createdAt: minutesAgo(47),
      turnId: "mobile-b2-refine-cmd",
      presentation: {
        kind: "refine",
        status: "failed",
        summary: "Refine failed",
        error: "Skill file conflicted with a concurrent edit from another session.",
      },
    },

    // Turn C (settled): thinking, a generic (non-python) tool row, and a python cell with diffs.
    {
      id: "mobile-c-user",
      role: "user",
      text: "Refactor the buffer trimming logic in demo-backend.ts and clean up the duplicate helper — run the tests after.",
      state: "complete",
      createdAt: minutesAgo(44),
      turnId: "mobile-c-user",
    },
    {
      id: "mobile-c-thinking",
      role: "assistant",
      text: "Locating the duplicate trimming helper before touching the loop",
      state: "complete",
      createdAt: minutesAgo(43),
      turnId: "mobile-c-user",
      presentation: {
        kind: "thinking",
        full: "Two call sites walk the message list looking for a removable index with almost identical predicates. Pulling that into one findOldestRemovable helper means the size cap and the age cap can't drift out of sync the next time either changes.",
      },
    },
    {
      id: "mobile-c-tool",
      role: "system",
      text: "npm test",
      state: "complete",
      createdAt: minutesAgo(43),
      turnId: "mobile-c-user",
      presentation: {
        kind: "tool",
        label: "bash",
        status: "complete",
        meta: "↑ 1 ↓ 14 lines · 4.2s",
      },
    },
    {
      id: "mobile-c-cell",
      role: "assistant",
      text: "apply_patch(diff)",
      state: "complete",
      createdAt: minutesAgo(43),
      turnId: "mobile-c-user",
      presentation: {
        kind: "python",
        lang: "python",
        status: "complete",
        preview: "apply_patch(diff)",
        meta: "↑ 2 lines · 900ms",
        code: `patch("src/server/demo-backend.ts", trim_fix)
patch("src/server/demo-backend.test.ts", trim_test_fix)`,
        diffs: [
          {
            path: "src/server/demo-backend.ts",
            oldStr: `    while (snapshot.messages.length > DEMO_MAX_TRANSCRIPT_MESSAGES || chars > DEMO_MAX_TRANSCRIPT_TEXT_CHARS) {
      const removableIndex = snapshot.messages.findIndex((message, index) =>
        index < snapshot.messages.length - 2 && !protectedMessages.has(message));
      if (removableIndex < 0) break;`,
            newStr: `    while (snapshot.messages.length > DEMO_MAX_TRANSCRIPT_MESSAGES || chars > DEMO_MAX_TRANSCRIPT_TEXT_CHARS) {
      const removableIndex = findOldestRemovable(snapshot.messages, protectedMessages);
      if (removableIndex < 0) break;`,
            startLine: 565,
          },
          {
            path: "src/server/demo-backend.test.ts",
            oldStr: `    expect(snapshot.messages.length).toBeLessThanOrEqual(256);
    expect(snapshot.messages.reduce((total, message) => total + message.text.length, 0))
      .toBeLessThanOrEqual(2 * 1024 * 1024);`,
            newStr: `    expect(snapshot.messages.length).toBeLessThanOrEqual(DEMO_MAX_TRANSCRIPT_MESSAGES);
    expect(snapshot.messages.reduce((total, message) => total + message.text.length, 0))
      .toBeLessThanOrEqual(DEMO_MAX_TRANSCRIPT_TEXT_CHARS);`,
            startLine: 156,
          },
        ],
        durationMs: 900,
      },
    },
    {
      id: "mobile-c-answer",
      role: "assistant",
      text: "Extracted the removable-message scan into a shared findOldestRemovable helper — both trim loops call it now, and the full suite passes (42 passed).",
      state: "complete",
      createdAt: minutesAgo(42),
      turnId: "mobile-c-user",
    },

    // Turn D (settled): a failed python cell followed by a normal answer.
    {
      id: "mobile-d-user",
      role: "user",
      text: "Optimize the loop that formats duration strings so it handles negative values.",
      state: "complete",
      createdAt: minutesAgo(36),
      turnId: "mobile-d-user",
    },
    {
      id: "mobile-d-cell",
      role: "assistant",
      text: "format_duration(-1500)",
      state: "failed",
      createdAt: minutesAgo(35),
      turnId: "mobile-d-user",
      presentation: {
        kind: "python",
        lang: "python",
        status: "failed",
        preview: "format_duration(-1500)",
        meta: "↑ 5 lines · 90ms · ValueError",
        code: `def format_duration(ms):
    if ms < 0:
        raise ValueError(f"duration must be non-negative, got {ms}")
    return f"{ms}ms" if ms < 1000 else f"{ms / 1000:.1f}s"

format_duration(-1500)`,
        error: {
          ename: "ValueError",
          evalue: "duration must be non-negative, got -1500",
          traceback: `Traceback (most recent call last):
  File "<cell>", line 5, in <module>
    format_duration(-1500)
  File "<cell>", line 3, in format_duration
    raise ValueError(f"duration must be non-negative, got {ms}")
ValueError: duration must be non-negative, got -1500`,
        },
        durationMs: 90,
      },
    },
    {
      id: "mobile-d-answer",
      role: "assistant",
      text: "That raises for negative input — clamp the duration to zero before formatting rather than raising. Want me to patch it?",
      state: "complete",
      createdAt: minutesAgo(35),
      turnId: "mobile-d-user",
    },

    // Turn E (settled): a turn that fails outright — the row the old
    // projection dropped entirely (zero rows for a failed empty-content turn).
    {
      id: "mobile-e-user",
      role: "user",
      text: "Summarize today's context-usage report.",
      state: "complete",
      createdAt: minutesAgo(30),
      turnId: "mobile-e-user",
    },
    {
      id: "mobile-e-error",
      role: "assistant",
      text: "The response failed before producing an answer.",
      state: "failed",
      createdAt: minutesAgo(30),
      turnId: "mobile-e-user",
      presentation: { kind: "error", label: "Turn failed" },
    },

    // Turn F (settled): a compaction notice, a rollback refine, and a
    // truncated python cell whose full sections are served via cellOutput.
    {
      id: "mobile-f-user",
      role: "user",
      text: "Keep going — continue the refactor and compact context if you need to.",
      state: "complete",
      createdAt: minutesAgo(22),
      turnId: "mobile-f-user",
    },
    {
      id: "mobile-f-notice",
      role: "system",
      text: "Compacted the last 41 exchanges to stay under the context budget.",
      state: "complete",
      createdAt: minutesAgo(20),
      turnId: "mobile-f-user",
      presentation: { kind: "notice", label: "Context compacted", tone: "info" },
    },
    {
      id: "mobile-f-agent-message",
      role: "system",
      text: "Finished the sweep. The three call sites all read the same stale value, so the fix belongs in the hook rather than in each caller.\n\n- `useComposerDrafts` — reads on every keystroke\n- `useSlashCommandMenu` — reads once per open\n- `Composer` — reads on submit",
      state: "complete",
      createdAt: minutesAgo(19),
      turnId: "mobile-f-user",
      presentation: { kind: "agent-message", sender: "draft-sweep", relationship: "child" },
    },
    {
      id: "mobile-f-refine-rollback",
      role: "system",
      text: "Rolled back the local prompt edit from the last refine — it regressed the python-cell preview wording.",
      state: "complete",
      createdAt: minutesAgo(19),
      turnId: "mobile-f-user",
      presentation: {
        kind: "refine",
        status: "complete",
        summary: "Rolled back the local prompt edit from the last refine — it regressed the python-cell preview wording.",
        scope: "local",
        rollback: true,
      },
    },
    {
      id: "mobile-f-cell",
      role: "assistant",
      text: "audit_transcript_budget()",
      state: "complete",
      createdAt: minutesAgo(17),
      turnId: "mobile-f-user",
      presentation: {
        kind: "python",
        lang: "python",
        status: "complete",
        preview: "audit_transcript_budget()",
        meta: "↑ 18 ↓ 4 lines · 3.1s",
        code: BUDGET_AUDIT_FULL_CODE.split("\n").slice(0, 6).join("\n"),
        codeTruncated: true,
        stdout: `${BUDGET_AUDIT_FULL_STDOUT.split("\n")[0]}\n`,
        stdoutTruncated: true,
        result: `${BUDGET_AUDIT_FULL_RESULT.slice(0, 48)}…`,
        resultTruncated: true,
        durationMs: 3100,
        cellId: BUDGET_AUDIT_CELL_ID,
      },
    },
    {
      id: "mobile-f-answer",
      role: "assistant",
      text: "Audited the transcript budget after compaction — we're well under the 2 MiB cap, so nothing else to trim right now.",
      state: "complete",
      createdAt: minutesAgo(16),
      turnId: "mobile-f-user",
    },

    // Live turn: streaming python cell, code still arriving.
    {
      id: "mobile-live-user",
      role: "user",
      text: "One more thing — show me it recovering from a kernel restart.",
      state: "complete",
      createdAt: minutesAgo(1),
      turnId: "mobile-live-user",
    },
    {
      id: "mobile-live-cell",
      role: "assistant",
      text: "restart_kernel_and_replay()",
      state: "streaming",
      createdAt: minutesAgo(0),
      turnId: "mobile-live-user",
      presentation: {
        kind: "python",
        lang: "python",
        status: "running",
        preview: "restart_kernel_and_replay()",
        code: `def restart_kernel_and_replay():
    kernel.restart()
    for cell in queued_cells:
`,
      },
    },
  ];
}

/** Session-dashboard refine history derived from the transcript's own refine rows (never invented separately). */
function refineHistoryFromMessages(messages: readonly TranscriptMessage[]): SessionDashboardRefine[] {
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
  return rows;
}

/** Full SessionDashboard fixture for the primary demo agent (root-mobile). */
function mobileDashboard(messages: readonly TranscriptMessage[]): SessionDashboard {
  const children: SessionDashboardChild[] = [
    {
      id: "root-mobile:child:protocol",
      agentId: "child-protocol",
      name: "Protocol designer",
      status: "running",
      toolName: "ipython",
      durationMs: 812_000,
      toolUseCount: 14,
      tokenCount: 52_000,
      recap: "Testing snapshot and replay semantics against the widened schema.",
    },
    {
      id: "root-mobile:child:review",
      agentId: "child-review",
      name: "Security reviewer",
      status: "running",
      durationMs: 340_000,
      toolUseCount: 6,
      tokenCount: 21_000,
      recap: "Waiting on a confirm dialog before deleting the stale build cache.",
    },
  ];
  return {
    status: "responding",
    recap: "Building syntax highlighting, refine surfacing, and transcript budget auditing for the mobile transcript view.",
    needsInput: false,
    contextUsage: { tokens: 148_000, contextWindow: 200_000, percent: 74 },
    children,
    refines: refineHistoryFromMessages(messages),
  };
}

function initialSnapshot(summary: AgentSummary): AgentSnapshot {
  if (summary.id === "root-mobile") {
    const messages = buildMobileTranscript();
    return { revision: 1, agentId: summary.id, messages, dashboard: mobileDashboard(messages), attention: [] };
  }
  const messages: TranscriptMessage[] = [
    {
      id: `${summary.id}-welcome-user`,
      role: "user",
      text: summary.parentId ? summary.description ?? "Handle the delegated task." : "Build a reliable mobile interface for Prime Agent.",
      state: "complete",
      createdAt: minutesAgo(120),
    },
    {
      id: `${summary.id}-welcome-assistant`,
      role: "assistant",
      text: summary.activity === "blocked" ? "An extension dialog is waiting for your response." : "I’m working through the task. Live events will appear here.",
      state: "complete",
      createdAt: minutesAgo(118),
    },
  ];
  const attention: AttentionRequest[] = summary.attention
    ? [
        {
          id: "attention-demo-dialog",
          agentId: summary.id,
          kind: "dialog",
          title: "Confirm before deleting the stale build cache?",
          detail: "The active extension is asking to confirm before it proceeds. Demo mode never performs the underlying action — this card exercises the extension dialog flow.",
          revision: 1,
          options: [
            { id: "__demo_cancel__", label: "Decline", tone: "danger" },
            { id: "confirm", label: "Confirm", tone: "safe" },
          ],
          createdAt: minutesAgo(6),
        },
      ]
    : [];
  return { revision: 1, agentId: summary.id, messages, dashboard: demoDashboard(summary), attention };
}

/** Minimal honest dashboard stub for the agents that don't ship the rich fixture. */
function demoDashboard(summary: AgentSummary): SessionDashboard {
  return {
    status: summary.lifecycle === "inactive" ? "inactive" : summary.activity === "working" ? "responding" : "idle",
    needsInput: summary.needsInput === true,
    ...(summary.needsInput
      ? { recap: "Waiting on you to confirm whether replay should include dropped events before continuing." }
      : {}),
    children: [],
    refines: [],
  };
}

const demoTree = new Map<string, ListedChild[]>([
  ["/", [
    { name: "projects", path: "/projects", hidden: false, directory: true },
    { name: "Documents", path: "/Documents", hidden: false, directory: true },
  ]],
  ["/projects", [
    { name: "prime-agent", path: "/projects/prime-agent", hidden: false, directory: true },
    { name: "mobile-ui", path: "/projects/mobile-ui", hidden: false, directory: true },
    { name: ".secrets", path: "/projects/.secrets", hidden: true, directory: true },
  ]],
  ["/projects/prime-agent", []],
  ["/projects/mobile-ui", [
    { name: "src", path: "/projects/mobile-ui/src", hidden: false, directory: true },
  ]],
  ["/projects/mobile-ui/src", []],
  ["/Documents", []],
]);

export class DemoBackend implements AgentBackend {
  readonly kind = "demo" as const;
  private hub!: EventHub;
  private readonly catalogState: CatalogSnapshot = { revision: 1, agents: structuredClone(initialAgents) };
  private readonly snapshots = new Map(initialAgents.map((item) => [item.id, initialSnapshot(item)]));
  private readonly cellOutputs = new Map<string, CellOutput>([[BUDGET_AUDIT_CELL_ID, budgetAuditCellOutput]]);
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly models = new Map<string, { provider: string; modelId: string }>();
  private readonly efforts = new Map<string, string>();
  private readonly heartbeats = new Map<string, { status: "active" | "paused"; schedule: string; deliveryMode: "steer" | "follow_up" }>();
  private readonly commandLocks = new Map<string, Promise<void>>();
  private createdCount = 0;

  async initialize(hub: EventHub): Promise<void> {
    this.hub = hub;
    hub.register("catalog", this.catalogState);
    for (const snapshot of this.snapshots.values()) hub.register(`agent:${snapshot.agentId}`, snapshot);
  }

  catalog(): CatalogSnapshot {
    return structuredClone(this.catalogState);
  }

  async agentSnapshot(agentId: string): Promise<AgentSnapshot | null> {
    const value = this.snapshots.get(agentId);
    return value ? structuredClone(value) : null;
  }

  attachment(_id: string): AttachmentData | null {
    return null;
  }

  cellOutput(id: string): CellOutput | null {
    const cached = this.cellOutputs.get(id);
    return cached ? structuredClone(cached) : null;
  }

  async sendMessage(input: SendMessageInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    if (input.text.trimStart().startsWith("/")) throw new BackendCapabilityError("Use the session command endpoint");
    if (input.images.length > 0) throw new BackendCapabilityError("Demo mode does not accept image attachments");
    if (!summary.capabilities.send) this.wakeAgent(summary, snapshot);

    this.clearTimers(input.agentId);
    const superseded = [...snapshot.messages].reverse().find((item) => item.state === "streaming");
    if (superseded) {
      superseded.state = "failed";
      superseded.text = superseded.text || "Superseded by a newer message.";
      snapshot.revision += 1;
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_updated", payload: superseded }, snapshot);
    }
    const createdAt = new Date().toISOString();
    const turnId = input.requestId;
    const userMessage: TranscriptMessage = {
      id: input.requestId,
      role: "user",
      text: input.text,
      state: "complete",
      createdAt,
      turnId,
    };
    const assistantId = randomUUID();
    const assistantMessage: TranscriptMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      state: "streaming",
      createdAt,
      turnId,
    };
    snapshot.messages.push(userMessage, assistantMessage);
    const trimmed = this.trimTranscript(snapshot);
    snapshot.revision += 1;
    this.markAgent(input.agentId, "working", null);
    if (trimmed) {
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    } else {
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: userMessage }, snapshot);
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: assistantMessage }, snapshot);
    }

    const chunks = [
      "I received your message. ",
      "The demo backend is streaming through the same replayable protocol that the Prime adapter will use. ",
      "Reconnect now and the gateway will replay the missing events or send a fresh snapshot.",
    ];
    const timers: NodeJS.Timeout[] = [];
    chunks.forEach((chunk, index) => {
      const timer = setTimeout(() => {
        const current = this.snapshots.get(input.agentId);
        if (!current) return;
        const message = current.messages.find((item) => item.id === assistantId);
        if (!message || message.state !== "streaming") return;
        message.text += chunk;
        if (index === chunks.length - 1) {
          message.state = "complete";
          this.markAgent(input.agentId, "idle", null);
        }
        const trimmed = this.trimTranscript(current);
        this.hub.publish(
          `agent:${input.agentId}`,
          trimmed
            ? { kind: "agent.replaced", payload: current }
            : { kind: "agent.message_updated", payload: message },
          current,
        );
      }, 500 * (index + 1));
      timers.push(timer);
    });
    this.timers.set(input.agentId, timers);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async slashCommandCatalog(agentId: string): Promise<SlashCommandCatalog | null> {
    const summary = this.catalogState.agents.find((item) => item.id === agentId);
    const snapshot = this.snapshots.get(agentId);
    if (!summary || !snapshot) return null;
    const active = summary.capabilities.send;
    const currentModel = this.models.get(agentId) ?? { provider: "demo", modelId: "standard" };
    const currentEffort = this.efforts.get(agentId) ?? "medium";
    const builtins = builtinSlashCommandEntries({
      sessionCommandsAvailable: active,
      supportedDirectCommands: active
        ? new Set(["model", "effort", "name", "context", "heartbeat"])
        : new Set(),
      modelOptions: [
        { value: "demo/standard", label: "Demo Standard", current: currentModel.modelId === "standard" },
        { value: "demo/fast", label: "Demo Fast", current: currentModel.modelId === "fast" },
      ],
      effortOptions: ["low", "medium", "high"].map((value) => ({ value, label: value, current: value === currentEffort })),
      heartbeatOptions: [
        { value: "status", label: "Show status" },
        { value: "pause", label: "Pause" },
        { value: "resume", label: "Resume" },
        { value: "stop", label: "Stop and clear" },
      ],
    });
    const detected = detectedSlashCommandEntries([
      { name: "demo-extension", source: "extension", sourceInfo: { path: "/hidden/demo.ts" } },
    ], new Set(builtins.map((entry) => entry.name)));
    return { agentId, agentRevision: snapshot.revision, partial: false, commands: [...builtins, ...detected] };
  }

  async executeSlashCommand(input: ExecuteSlashCommandInput): Promise<SlashCommandAccepted> {
    return this.withCommandLock(input.agentId, () => this.executeSlashCommandLocked(input));
  }

  private async executeSlashCommandLocked(input: ExecuteSlashCommandInput): Promise<SlashCommandAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.send) throw new BackendCapabilityError("This agent cannot run commands");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");

    if (SESSION_SLASH_COMMAND_NAMES.includes(input.name as typeof SESSION_SLASH_COMMAND_NAMES[number])) {
      const createdAt = new Date().toISOString();
      const commandText = `/${input.name}${input.args ? ` ${input.args}` : ""}`;
      const turnId = input.requestId;
      const commandMessage: TranscriptMessage = {
        id: input.requestId,
        role: "user",
        text: commandText,
        state: "complete",
        createdAt,
        turnId,
      };
      const resultMessage: TranscriptMessage = {
        id: randomUUID(),
        role: "system",
        text: `/${input.name} accepted.`,
        state: "complete",
        createdAt,
        turnId,
      };
      snapshot.messages.push(commandMessage, resultMessage);
      const trimmed = this.trimTranscript(snapshot);
      snapshot.revision += 1;
      if (trimmed) {
        this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
      } else {
        this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: commandMessage }, snapshot);
        this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_added", payload: resultMessage }, snapshot);
      }
      return {
        accepted: true,
        requestId: input.requestId,
        revision: snapshot.revision,
        result: { kind: "session_accepted" },
      };
    }

    if (input.name === "demo-extension") {
      return {
        accepted: true,
        requestId: input.requestId,
        revision: snapshot.revision,
        result: { kind: "experimental_accepted", source: "extension" },
      };
    }

    let result: SlashCommandResult;
    let mutated = false;
    switch (input.name) {
      case "model": {
        if (!input.args) {
          const current = this.models.get(input.agentId) ?? { provider: "demo", modelId: "standard" };
          result = { kind: "model", ...current };
          break;
        }
        if (input.args !== "demo/standard" && input.args !== "demo/fast") {
          throw new BackendCapabilityError("Choose an exact available model");
        }
        const modelId = input.args.slice("demo/".length);
        this.models.set(input.agentId, { provider: "demo", modelId });
        mutated = true;
        result = { kind: "model", provider: "demo", modelId };
        break;
      }
      case "effort": {
        const levels = ["low", "medium", "high"];
        if (input.args && !levels.includes(input.args.toLowerCase())) {
          throw new BackendCapabilityError("Choose an available thinking level");
        }
        if (input.args) {
          this.efforts.set(input.agentId, input.args.toLowerCase());
          mutated = true;
        }
        result = { kind: "effort", level: this.efforts.get(input.agentId) ?? "medium", availableLevels: levels };
        break;
      }
      case "name": {
        if (input.args) {
          const name = sessionNameSchema.safeParse(input.args);
          if (!name.success) throw new BackendCapabilityError("Session name must be a single line of at most 200 characters");
          summary.name = name.data;
          mutated = true;
          this.catalogState.revision += 1;
          this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
        }
        result = { kind: "name", ...(summary.name ? { name: summary.name } : {}) };
        break;
      }
      case "context": {
        if (input.args) throw new BackendCapabilityError("Context command does not accept arguments");
        result = { kind: "context_usage", contextTokens: 12_000, contextWindow: 200_000, percent: 6, totalTokens: 18_500, cost: 0.12 };
        break;
      }
      case "heartbeat": {
        const parsed = parseHeartbeatArgs(input.args);
        if (!parsed) throw new BackendCapabilityError("Invalid heartbeat command arguments");
        let heartbeat = this.heartbeats.get(input.agentId);
        if (parsed.type === "set") {
          heartbeat = { status: "active", schedule: parsed.schedule, deliveryMode: parsed.deliveryMode ?? "steer" };
          this.heartbeats.set(input.agentId, heartbeat);
          mutated = true;
        } else if (parsed.type === "pause" && heartbeat) {
          heartbeat = { ...heartbeat, status: "paused" };
          this.heartbeats.set(input.agentId, heartbeat);
          mutated = true;
        } else if (parsed.type === "resume" && heartbeat) {
          heartbeat = { ...heartbeat, status: "active" };
          this.heartbeats.set(input.agentId, heartbeat);
          mutated = true;
        } else if (parsed.type === "clear") {
          mutated = this.heartbeats.delete(input.agentId);
          heartbeat = undefined;
        }
        result = heartbeat
          ? { kind: "heartbeat", status: heartbeat.status, schedule: heartbeat.schedule, deliveryMode: heartbeat.deliveryMode }
          : { kind: "heartbeat", status: "none" };
        break;
      }
      default:
        throw new BackendCapabilityError("Command is not available");
    }
    if (mutated) {
      snapshot.revision += 1;
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    }
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision, result };
  }

  async abort(input: AbortInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.abort) throw new BackendCapabilityError("This agent cannot be aborted");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    this.clearTimers(input.agentId);
    const streaming = [...snapshot.messages].reverse().find((item: TranscriptMessage) => item.state === "streaming");
    if (streaming) {
      streaming.state = "failed";
      streaming.text = streaming.text || "Stopped.";
      snapshot.revision += 1;
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_updated", payload: streaming }, snapshot);
    }
    this.markAgent(input.agentId, "idle", null);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async rename(input: RenameInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.rename) throw new BackendCapabilityError("This agent cannot be renamed");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    // Deliberately not run through `uniqueSessionName`: creation invents a name
    // and may disambiguate it, but a rename is a name the user typed, and
    // silently appending a number to it is a worse answer than two rows that
    // share a label.
    summary.name = input.name;
    summary.updatedAt = new Date().toISOString();
    snapshot.revision += 1;
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async stop(input: StopInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.stop) throw new BackendCapabilityError("This agent has no live session to stop");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");

    // Stopping ends the session; it does not discard it. The agent lands
    // exactly where a session that was never woken sits — inactive, resumable,
    // and still renameable — which is what the live daemon leaves behind too.
    this.clearTimers(input.agentId);
    const streaming = [...snapshot.messages].reverse().find((item: TranscriptMessage) => item.state === "streaming");
    if (streaming) {
      streaming.state = "failed";
      streaming.text = streaming.text || "Stopped.";
      this.hub.publish(`agent:${input.agentId}`, { kind: "agent.message_updated", payload: streaming }, snapshot);
    }
    summary.lifecycle = "inactive";
    summary.activity = "idle";
    summary.attention = null;
    summary.unreadCount = 0;
    summary.capabilities = inactiveCapabilities;
    summary.updatedAt = new Date().toISOString();
    snapshot.attention = [];
    snapshot.dashboard = demoDashboard(summary);
    snapshot.revision += 1;
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    this.hub.publish(`agent:${input.agentId}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async delete(input: DeleteInput): Promise<MutationAccepted> {
    const snapshot = this.requiredSnapshot(input.agentId);
    const summary = this.requiredSummary(input.agentId);
    if (!summary.capabilities.delete) throw new BackendCapabilityError("Stop this session before deleting it");
    if (input.expectedRevision !== snapshot.revision) throw new BackendConflictError("The agent changed. Refresh and try again.");
    if (input.confirmName !== summary.name) throw new BackendCapabilityError("That is not this session's name");

    // The revision is read before the removal, not after: there is no snapshot
    // left to read once the agent is gone, and the caller still needs the
    // number the mutation settled at.
    const revision = snapshot.revision + 1;
    this.clearTimers(input.agentId);
    this.snapshots.delete(input.agentId);
    this.catalogState.agents = this.catalogState.agents.filter((agent) => agent.id !== input.agentId);
    this.catalogState.revision += 1;
    // Unregistering detaches anyone watching this agent's stream with
    // `stream_gone`, which is the truth: it is gone.
    this.hub.unregister(`agent:${input.agentId}`);
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    return { accepted: true, requestId: input.requestId, revision };
  }

  async resolveAttention(input: ResolveAttentionInput): Promise<MutationAccepted> {
    const snapshot = [...this.snapshots.values()].find((value) => value.attention.some((item) => item.id === input.attentionId));
    if (!snapshot) throw new BackendNotFoundError("Attention request not found");
    const request = snapshot.attention.find((item) => item.id === input.attentionId)!;
    if (input.expectedRevision !== request.revision) throw new BackendConflictError("This request has already changed");
    if (!request.options.some((option) => option.id === input.optionId)) throw new BackendCapabilityError("Unknown response option");
    snapshot.attention = snapshot.attention.filter((item) => item.id !== input.attentionId);
    snapshot.revision += 1;
    this.markAgent(snapshot.agentId, "idle", null);
    this.hub.publish(`agent:${snapshot.agentId}`, { kind: "agent.attention_resolved", payload: { id: input.attentionId } }, snapshot);
    return { accepted: true, requestId: input.requestId, revision: snapshot.revision };
  }

  async listDirectories(requestedPath?: string): Promise<DirectoryListing> {
    const target = absoluteDirectoryPath(requestedPath, "/");
    const children = demoTree.get(target);
    if (!children) throw new BackendNotFoundError("Directory not found");
    const { entries, truncated } = selectDirectoryEntries(children);
    return { path: target, home: "/", crumbs: directoryCrumbs(target), entries, truncated };
  }

  async createSession(input: CreateSessionInput): Promise<SessionCreated> {
    if (!demoTree.has(input.cwd)) throw new BackendNotFoundError("Directory not found");
    if (this.catalogState.agents.length >= DEMO_MAX_AGENTS) {
      throw new BackendCapabilityError("Demo session limit reached");
    }
    this.createdCount += 1;
    const id = `root-created-${this.createdCount}`;
    const baseName = input.name?.trim() || path.basename(input.cwd) || `New session ${this.createdCount}`;
    const summary = agent({
      id,
      rootId: id,
      parentId: null,
      depth: 0,
      name: uniqueSessionName(baseName, this.catalogState.agents.map((item) => item.name)),
      description: `Created in ${input.cwd}`,
      activity: "idle",
      cwd: input.cwd,
    });
    this.catalogState.agents.push(summary);
    this.catalogState.revision += 1;
    this.snapshots.set(id, { revision: 1, agentId: id, messages: [], dashboard: demoDashboard(summary), attention: [] });
    this.hub.register(`agent:${id}`, this.snapshots.get(id)!);
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    return { requestId: input.requestId, agentId: id };
  }

  async close(): Promise<void> {
    for (const agentId of this.timers.keys()) this.clearTimers(agentId);
    this.commandLocks.clear();
  }

  private withCommandLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return withSerialLock(this.commandLocks, agentId, operation);
  }

  private wakeAgent(summary: AgentSummary, snapshot: AgentSnapshot): void {
    if (!summary.capabilities.resume) throw new BackendCapabilityError("This agent cannot receive messages");
    summary.lifecycle = "live";
    summary.activity = "idle";
    summary.capabilities = { ...fullCapabilities, resume: false };
    summary.updatedAt = new Date().toISOString();
    snapshot.revision += 1;
    snapshot.dashboard = demoDashboard(summary);
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
    this.hub.publish(`agent:${summary.id}`, { kind: "agent.replaced", payload: snapshot }, snapshot);
  }

  private requiredSnapshot(agentId: string): AgentSnapshot {
    const value = this.snapshots.get(agentId);
    if (!value) throw new BackendNotFoundError("Agent not found");
    return value;
  }

  private requiredSummary(agentId: string): AgentSummary {
    const value = this.catalogState.agents.find((item) => item.id === agentId);
    if (!value) throw new BackendNotFoundError("Agent not found");
    return value;
  }

  private trimTranscript(snapshot: AgentSnapshot): boolean {
    const protectedMessages = new Set<TranscriptMessage>();
    snapshot.messages.forEach((message, index) => {
      if (message.state !== "streaming") return;
      protectedMessages.add(message);
      const previous = snapshot.messages[index - 1];
      if (previous?.role === "user") protectedMessages.add(previous);
    });
    const totalChars = () => snapshot.messages.reduce((total, message) => total + message.text.length, 0);
    let chars = totalChars();
    let trimmed = false;
    while (snapshot.messages.length > DEMO_MAX_TRANSCRIPT_MESSAGES || chars > DEMO_MAX_TRANSCRIPT_TEXT_CHARS) {
      const removableIndex = snapshot.messages.findIndex((message, index) =>
        index < snapshot.messages.length - 2 && !protectedMessages.has(message));
      if (removableIndex < 0) break;
      const [removed] = snapshot.messages.splice(removableIndex, 1);
      chars -= removed?.text.length ?? 0;
      trimmed = true;
    }
    return trimmed;
  }

  private markAgent(agentId: string, activity: AgentSummary["activity"], attention: AgentSummary["attention"]): void {
    const summary = this.requiredSummary(agentId);
    summary.activity = activity;
    summary.attention = attention;
    summary.unreadCount = attention ? 1 : 0;
    summary.updatedAt = new Date().toISOString();
    this.catalogState.revision += 1;
    this.hub.publish("catalog", { kind: "catalog.replaced", payload: this.catalogState }, this.catalogState);
  }

  private clearTimers(agentId: string): void {
    for (const timer of this.timers.get(agentId) ?? []) clearTimeout(timer);
    this.timers.delete(agentId);
  }
}
