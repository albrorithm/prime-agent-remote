import { describe, expect, it, vi } from "vitest";
import type { AgentSummary, CatalogSnapshot } from "../protocol.js";
import { TurnEndNotifier, type TurnEndEvent } from "./turn-end-notifier.js";

function agent(overrides: Partial<AgentSummary> & Pick<AgentSummary, "id">): AgentSummary {
  return {
    rootId: overrides.id,
    parentId: null,
    depth: 0,
    name: "Session",
    lifecycle: "live",
    activity: "idle",
    attention: null,
    unreadCount: 0,
    childCount: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    capabilities: {} as AgentSummary["capabilities"],
    ...overrides,
  };
}

/* A virtual clock, because everything this class decides is about elapsed time
   rather than about values.

   `advance` steps the clock in poll-sized increments and reads at each one,
   because that is what the gateway does — it ticks on a timer, not on
   transitions, and never sees the moment anything changed. A harness that
   jumped the clock and read once instead made every duration look like zero:
   the same tick that first saw an agent idle was the one asked how long it had
   been idle. */
const POLL_MS = 2_000;
function harness(options: { quietMs?: number; resumeMs?: number } = {}) {
  let clock = 0;
  let agents: AgentSummary[] = [];
  const sent: TurnEndEvent[] = [];
  const notifier = new TurnEndNotifier({
    catalog: (): CatalogSnapshot => ({ revision: 1, agents }),
    notify: (event) => sent.push(event),
    now: () => clock,
    quietMs: options.quietMs ?? 45_000,
    resumeMs: options.resumeMs ?? 90_000,
  });
  return {
    notifier,
    sent,
    set(next: AgentSummary[]) { agents = next; },
    /** Let `ms` pass, polling throughout, the way the gateway's timer does. */
    advance(ms: number) {
      const until = clock + ms;
      while (clock < until) {
        clock = Math.min(until, clock + POLL_MS);
        notifier.tick();
      }
    },
    tick() { notifier.tick(); },
  };
}

const WORKING = { activity: "working" } as const;
const IDLE = { activity: "idle" } as const;

describe("TurnEndNotifier", () => {
  it("notifies once when a turn goes quiet and stays quiet", () => {
    const h = harness();
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(1_000);

    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(1_000);
    expect(h.sent).toEqual([]);

    h.advance(50_000);
    expect(h.sent).toEqual([{ agentId: "root", outcome: "complete" }]);

    // And does not keep saying it.
    h.advance(120_000);
    expect(h.sent).toHaveLength(1);
  });

  /* The case the whole class exists for, in the shape it was reported: Prime
     Agent ends, then a straggling subagent posts its report and wakes the
     session again for a few seconds, more than once. That is one piece of news,
     not three. */
  it("gives stragglers one notification between them, not one each", () => {
    const h = harness();
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(60_000);

    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(5_000);

    // Straggler one: three seconds of work, then quiet again.
    h.set([agent({ id: "root", ...WORKING })]);
    h.advance(3_000);
    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(20_000);
    expect(h.sent).toEqual([]);

    // Straggler two, still inside the quiet window.
    h.set([agent({ id: "root", ...WORKING })]);
    h.advance(3_000);
    h.set([agent({ id: "root", ...IDLE })]);

    h.advance(50_000);
    expect(h.sent).toEqual([{ agentId: "root", outcome: "complete" }]);

    // A third straggler after the notification must not produce a second one:
    // it is too short to be new work, so it cannot re-arm.
    h.set([agent({ id: "root", ...WORKING })]);
    h.advance(3_000);
    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(120_000);
    expect(h.sent).toHaveLength(1);
  });

  it("treats work that runs long as a new turn worth its own notification", () => {
    const h = harness();
    h.set([agent({ id: "root", ...IDLE })]);
    h.notifier.arm("root");
    h.advance(50_000);
    expect(h.sent).toHaveLength(1);

    // Not a straggler: two minutes of continuous work arms it again without
    // anyone having to tell it, which is what covers a turn started from the
    // terminal rather than from the app.
    h.set([agent({ id: "root", ...WORKING })]);
    h.advance(120_000);
    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(50_000);
    expect(h.sent).toHaveLength(2);
  });

  it("says nothing at all for an agent nobody asked for anything", () => {
    const h = harness();
    // Never armed: a session idling since before the gateway started is not a
    // turn that just ended.
    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(600_000);
    expect(h.sent).toEqual([]);
  });

  /* Blocked means an attention request, which has already sent its own, better
     notification. Settling there would follow "needs your answer" with
     "finished" about the same moment. */
  it("does not call a blocked agent finished", () => {
    const h = harness();
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(1_000);

    h.set([agent({ id: "root", activity: "blocked", attention: "question" })]);
    h.advance(300_000);
    expect(h.sent).toEqual([]);

    // Answering it resumes the turn, and the gateway re-arms; the end of that
    // resumed turn is worth saying.
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(2_000);
    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(50_000);
    expect(h.sent).toEqual([{ agentId: "root", outcome: "complete" }]);
  });

  it("lets an attention request take the news instead", () => {
    const h = harness();
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(1_000);
    h.notifier.disarm("root");

    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(120_000);
    expect(h.sent).toEqual([]);
  });

  /* Children roll up into their root's activity already, so watching them adds
     no information — but it does add a subagent announcing its own ending while
     the root is still working, which is a notification about nothing. */
  it("ignores subagents entirely", () => {
    const h = harness();
    h.set([
      agent({ id: "root", ...WORKING }),
      agent({ id: "child", parentId: "root", rootId: "root", depth: 1, ...WORKING }),
    ]);
    h.notifier.arm("root");
    h.notifier.arm("child");
    h.advance(120_000);

    h.set([
      agent({ id: "root", ...WORKING }),
      agent({ id: "child", parentId: "root", rootId: "root", depth: 1, ...IDLE }),
    ]);
    h.advance(120_000);
    expect(h.sent).toEqual([]);
  });

  // Work asked of a child is news about its root, the only agent watched.
  it("arms the root when a subagent is the one asked for work", () => {
    const h = harness();
    h.set([
      agent({ id: "root", ...WORKING }),
      agent({ id: "child", parentId: "root", rootId: "root", depth: 1, ...WORKING }),
    ]);
    h.notifier.arm("child");
    h.advance(1_000);
    h.set([
      agent({ id: "root", ...IDLE }),
      agent({ id: "child", parentId: "root", rootId: "root", depth: 1, ...IDLE }),
    ]);
    h.advance(50_000);
    expect(h.sent).toEqual([{ agentId: "root", outcome: "complete" }]);
  });

  it("reports a failed turn as failed", () => {
    const h = harness();
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(1_000);
    h.set([agent({ id: "root", ...IDLE, lifecycle: "failed" })]);
    h.advance(50_000);
    expect(h.sent).toEqual([{ agentId: "root", outcome: "failed" }]);
  });

  it("forgets an agent that has left the catalog", () => {
    const h = harness();
    h.set([agent({ id: "root", ...WORKING })]);
    h.notifier.arm("root");
    h.advance(1_000);

    h.set([]);
    h.advance(1_000);
    // Back with the same id — a new session reusing it must start unarmed
    // rather than inherit a notification owed to a session that is gone.
    h.set([agent({ id: "root", ...IDLE })]);
    h.advance(120_000);
    expect(h.sent).toEqual([]);
  });

  it("does not treat a starting session as a finished one", () => {
    const h = harness();
    h.set([agent({ id: "root", lifecycle: "starting", activity: "idle" })]);
    h.notifier.arm("root");
    h.advance(120_000);
    expect(h.sent).toEqual([]);
  });

  it("survives a catalog that throws nothing at it", () => {
    const notify = vi.fn();
    const notifier = new TurnEndNotifier({ catalog: () => ({ revision: 1, agents: [] }), notify });
    notifier.arm("gone");
    notifier.tick();
    expect(notify).not.toHaveBeenCalled();
  });
});
