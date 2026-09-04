import { render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptMessage, TranscriptPresentation } from "../../protocol";
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsProvider, useSettings, type Settings } from "../settings";
import { formatWorkDuration, groupIntoTurns, splitTurn, splitTurnSegments, TurnGroup, turnSettled, turnWallClockMs, VISIBLE_PROSE_CHARS } from "./TurnGroup";

function render(ui: ReactElement, overrides: Partial<Settings> = {}) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...overrides }));
  return renderBare(ui, { wrapper: SettingsProvider });
}

function TurnsCollapsedToggle() {
  const { settings, setSetting } = useSettings();
  return <button onClick={() => setSetting("turnsCollapsed", !settings.turnsCollapsed)}>flip turnsCollapsed</button>;
}

function row(
  id: string,
  overrides: Partial<TranscriptMessage> & { presentation?: TranscriptPresentation } = {},
): TranscriptMessage {
  return {
    id,
    role: "assistant",
    text: id,
    state: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function prompt(id: string, turnId: string): TranscriptMessage {
  return row(id, { role: "user", turnId, text: `prompt ${id}` });
}

function pythonRow(id: string, turnId: string, status: "running" | "complete" | "failed", durationMs?: number): TranscriptMessage {
  return row(id, {
    turnId,
    state: status === "running" ? "streaming" : "complete",
    presentation: { kind: "python", lang: "python", status, preview: id, ...(durationMs !== undefined ? { durationMs } : {}) },
  });
}

function thinkingRow(id: string, turnId: string): TranscriptMessage {
  return row(id, { turnId, presentation: { kind: "thinking" } });
}

function answer(id: string, turnId: string, state: TranscriptMessage["state"] = "complete"): TranscriptMessage {
  return row(id, { turnId, state, text: `answer ${id}` });
}

/** Stamps a turn's rows with an increasing wall clock so the summary can show a span. */
function spanning(rows: TranscriptMessage[], stepMs: number): TranscriptMessage[] {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return rows.map((entry, index) => ({ ...entry, createdAt: new Date(base + index * stepMs).toISOString() }));
}

const renderPlainRow = (message: TranscriptMessage) => <div key={message.id} data-row={message.id}>{message.text}</div>;

describe("groupIntoTurns", () => {
  it("groups consecutive rows sharing a turnId and keeps turnId-less rows flat", () => {
    const items = groupIntoTurns([
      row("legacy-1"),
      prompt("u1", "u1"),
      thinkingRow("t1", "u1"),
      answer("a1", "u1"),
      row("legacy-2"),
      prompt("u2", "u2"),
      answer("a2", "u2"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["row", "turn", "row", "turn"]);
    expect(items[1]).toMatchObject({ turnId: "u1", rows: [{ id: "u1" }, { id: "t1" }, { id: "a1" }] });
    expect(items[3]).toMatchObject({ turnId: "u2" });
  });

  it("splits a turnId run interrupted by a flat row and deduplicates keys", () => {
    const items = groupIntoTurns([
      prompt("u1", "u1"),
      row("legacy"),
      answer("a1", "u1"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["turn", "row", "turn"]);
    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("splitTurn", () => {
  it("separates prompt, work, and the trailing answer", () => {
    const { prompt: promptRows, work, tail } = splitTurn([
      prompt("u1", "u1"),
      thinkingRow("t1", "u1"),
      pythonRow("p1", "u1", "complete", 400),
      answer("a1", "u1"),
    ]);
    expect(promptRows.map((r) => r.id)).toEqual(["u1"]);
    expect(work.map((r) => r.id)).toEqual(["t1", "p1"]);
    expect(tail.map((r) => r.id)).toEqual(["a1"]);
  });

  it("keeps a terminal error row in the visible tail", () => {
    const { work, tail } = splitTurn([
      prompt("u1", "u1"),
      pythonRow("p1", "u1", "failed"),
      row("e1", { turnId: "u1", state: "failed", presentation: { kind: "error", label: "Turn failed" } }),
    ]);
    expect(work.map((r) => r.id)).toEqual(["p1"]);
    expect(tail.map((r) => r.id)).toEqual(["e1"]);
  });

  it("treats a slash command's terminal refine row as the outcome, but a mid-turn refine as work", () => {
    const refinePresentation: TranscriptPresentation = { kind: "refine", status: "complete", summary: "Refined" };
    const terminal = splitTurn([
      prompt("cmd", "cmd"),
      row("r1", { role: "system", turnId: "cmd", presentation: refinePresentation }),
    ]);
    expect(terminal.work).toEqual([]);
    expect(terminal.tail.map((r) => r.id)).toEqual(["r1"]);

    const midTurn = splitTurn([
      prompt("u1", "u1"),
      row("r1", { role: "system", turnId: "u1", presentation: refinePresentation }),
      pythonRow("p1", "u1", "complete"),
      answer("a1", "u1"),
    ]);
    expect(midTurn.work.map((r) => r.id)).toEqual(["r1", "p1"]);
    expect(midTurn.tail.map((r) => r.id)).toEqual(["a1"]);
  });
});

describe("turnSettled", () => {
  it("requires an outcome row and nothing streaming or running", () => {
    const turnId = "u1";
    expect(turnSettled([prompt("u1", turnId)])).toBe(false);
    expect(turnSettled([prompt("u1", turnId), pythonRow("p1", turnId, "running")])).toBe(false);
    expect(turnSettled([prompt("u1", turnId), pythonRow("p1", turnId, "complete")])).toBe(false);
    expect(turnSettled([prompt("u1", turnId), pythonRow("p1", turnId, "complete"), answer("a1", turnId, "streaming")])).toBe(false);
    expect(turnSettled([prompt("u1", turnId), pythonRow("p1", turnId, "complete"), answer("a1", turnId)])).toBe(true);
    expect(turnSettled([prompt("u1", turnId), row("e1", { turnId, state: "failed", presentation: { kind: "error", label: "Turn failed" } })])).toBe(true);
  });
});

describe("formatWorkDuration", () => {
  it("formats milliseconds, seconds, and minutes", () => {
    expect(formatWorkDuration(420)).toBe("420ms");
    expect(formatWorkDuration(1320)).toBe("1.3s");
    expect(formatWorkDuration(3100)).toBe("3.1s");
    expect(formatWorkDuration(48_000)).toBe("48s");
    expect(formatWorkDuration(96_000)).toBe("1m 36s");
    expect(formatWorkDuration(120_000)).toBe("2m");
  });
});

describe("turnWallClockMs", () => {
  it("spans the first row to the last, not the python compute inside it", () => {
    const rows = spanning([prompt("u1", "u1"), pythonRow("p1", "u1", "complete", 420), answer("a1", "u1")], 60_000);
    expect(turnWallClockMs(rows)).toBe(120_000);
  });

  it("returns 0 for a span it cannot trust", () => {
    expect(turnWallClockMs([])).toBe(0);
    expect(turnWallClockMs([prompt("u1", "u1")])).toBe(0);
    expect(turnWallClockMs([row("a", { createdAt: "not a date" }), row("b")])).toBe(0);
    const backwards = [row("a", { createdAt: "2026-01-01T00:01:00.000Z" }), row("b", { createdAt: "2026-01-01T00:00:00.000Z" })];
    expect(turnWallClockMs(backwards)).toBe(0);
  });
});

describe("TurnGroup", () => {
  function liveRows(turnId = "u1"): TranscriptMessage[] {
    return [prompt("u1", turnId), thinkingRow("t1", turnId), pythonRow("p1", turnId, "running")];
  }

  function settledRows(turnId = "u1"): TranscriptMessage[] {
    // 30s between rows, so the 90s wall clock is nothing like the 420ms of
    // python compute the summary used to report.
    return spanning(
      [prompt("u1", turnId), thinkingRow("t1", turnId), pythonRow("p1", turnId, "complete", 420), answer("a1", turnId)],
      30_000,
    );
  }

  it("keeps a live turn's work open, then auto-collapses exactly when the answer lands", () => {
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows()} renderRow={renderPlainRow} />);
    const details = () => view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details().open).toBe(true);
    expect(screen.getByText("Working… · 2 steps")).toBeInTheDocument();

    view.rerender(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    expect(details().open).toBe(false);
    expect(screen.getByText("2 steps · 1m 30s")).toBeInTheDocument();
  });

  it("mounts no work rows while a settled turn is collapsed", () => {
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    expect(view.container.querySelector("details.turn-work")!.hasAttribute("open")).toBe(false);
    expect(view.container.querySelector("[data-row='t1']")).toBeNull();
    expect(view.container.querySelector("[data-row='p1']")).toBeNull();
    // The summary still reports what is inside without paying for it.
    expect(screen.getByText("2 steps · 1m 30s")).toBeInTheDocument();
  });

  it("mounts work rows on first expand and keeps them after re-collapsing", async () => {
    const user = userEvent.setup();
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    expect(view.container.querySelector("[data-row='t1']")).toBeNull();

    await user.click(screen.getByText("2 steps · 1m 30s"));
    expect(view.container.querySelector("[data-row='t1']")).not.toBeNull();

    await user.click(screen.getByText("2 steps · 1m 30s"));
    expect(view.container.querySelector("details.turn-work")!.hasAttribute("open")).toBe(false);
    // Still mounted, so anything the user expanded inside survives the toggle.
    expect(view.container.querySelector("[data-row='t1']")).not.toBeNull();
  });

  it("mounts a live turn's work rows immediately", () => {
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows()} renderRow={renderPlainRow} />);
    expect(view.container.querySelector("[data-row='t1']")).not.toBeNull();
  });

  it("keeps the prompt and answer outside the collapsible work region", () => {
    // Opened, because a collapsed turn deliberately mounts no work rows at all.
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />, { turnsCollapsed: false });
    const details = view.container.querySelector("details.turn-work")!;
    expect(details.querySelector("[data-row='t1']")).not.toBeNull();
    expect(details.querySelector("[data-row='p1']")).not.toBeNull();
    expect(details.querySelector("[data-row='u1']")).toBeNull();
    expect(details.querySelector("[data-row='a1']")).toBeNull();
    expect(view.container.querySelector("[data-row='u1']")).not.toBeNull();
    expect(view.container.querySelector("[data-row='a1']")).not.toBeNull();
  });

  it("renders a failed turn's error row outside the collapsed region", () => {
    const rows = [
      prompt("u1", "u1"),
      pythonRow("p1", "u1", "failed", 90),
      row("e1", { turnId: "u1", state: "failed", presentation: { kind: "error", label: "Turn failed" }, text: "The response failed." }),
    ];
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={rows} renderRow={renderPlainRow} />);
    const details = view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-row='e1']")).toBeNull();
    expect(view.container.querySelector("[data-row='e1']")).not.toBeNull();
  });

  it("renders no collapsible region when a turn has no work rows", () => {
    const rows = [prompt("u1", "u1"), answer("a1", "u1")];
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={rows} renderRow={renderPlainRow} />);
    expect(view.container.querySelector("details")).toBeNull();
  });

  it("reports the turn's wall clock, not the python time inside it", () => {
    render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    expect(screen.getByText("2 steps · 1m 30s")).toBeInTheDocument();
    expect(screen.queryByText("2 steps · 420ms")).toBeNull();
  });

  it("omits the duration when no work row carries one", () => {
    const rows = [prompt("u1", "u1"), thinkingRow("t1", "u1"), answer("a1", "u1")];
    render(<TurnGroup agentName="Agent" turnId="u1" rows={rows} renderRow={renderPlainRow} />);
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });

  it("prefers the session recap for a settled turn's summary, keeping the counts as meta", () => {
    render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} recap="Refactored the cell renderer" renderRow={renderPlainRow} />);
    expect(screen.getByText("Refactored the cell renderer")).toBeInTheDocument();
    expect(screen.getByText("2 steps · 1m 30s")).toBeInTheDocument();
  });

  it("ignores the recap while the turn is still live", () => {
    render(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows()} recap="Still working" renderRow={renderPlainRow} />);
    expect(screen.queryByText("Still working")).not.toBeInTheDocument();
    expect(screen.getByText("Working… · 2 steps")).toBeInTheDocument();
  });

  it("lets the user re-expand a settled turn, persisting across re-renders", async () => {
    const user = userEvent.setup();
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    const details = () => view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details().open).toBe(false);

    await user.click(view.container.querySelector("summary.turn-summary")!);
    expect(details().open).toBe(true);

    view.rerender(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows().map((r) => ({ ...r }))} renderRow={renderPlainRow} />);
    expect(details().open).toBe(true);
  });

  it("lets the user collapse a live turn, overriding the auto-open", async () => {
    const user = userEvent.setup();
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows()} renderRow={renderPlainRow} />);
    const details = () => view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details().open).toBe(true);

    await user.click(view.container.querySelector("summary.turn-summary")!);
    expect(details().open).toBe(false);

    view.rerender(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows().map((r) => ({ ...r }))} renderRow={renderPlainRow} />);
    expect(details().open).toBe(false);
  });

  it("skips re-rendering a settled turn when a new array carries identical content", () => {
    const renderRow = vi.fn(renderPlainRow);
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderRow} />);
    const callsAfterMount = renderRow.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    view.rerender(<TurnGroup agentName="Agent" turnId="u1" rows={settledRows().map((r) => ({ ...r }))} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBe(callsAfterMount);

    const changed = settledRows();
    changed[changed.length - 1] = { ...changed[changed.length - 1], text: "answer a1 (edited)" };
    view.rerender(<TurnGroup agentName="Agent" turnId="u1" rows={changed} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  /* renderRow closes over the agent's name, and no comparator can see inside a
     closure. Renaming a session used to leave every settled turn rendering the
     old name — author lines and message-action labels alike — next to live
     turns rendering the new one, until an agent switch remounted them. */
  it("rebuilds a settled turn's rows when the agent is renamed", () => {
    const renderRow = vi.fn(renderPlainRow);
    const view = render(<TurnGroup agentName="Old name" turnId="u1" rows={settledRows()} renderRow={renderRow} />);
    const callsAfterMount = renderRow.mock.calls.length;

    view.rerender(<TurnGroup agentName="New name" turnId="u1" rows={settledRows()} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("always re-renders a live turn so streaming updates come through", () => {
    const renderRow = vi.fn(renderPlainRow);
    const view = render(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows()} renderRow={renderRow} />);
    const callsAfterMount = renderRow.mock.calls.length;

    view.rerender(<TurnGroup agentName="Agent" turnId="u1" rows={liveRows().map((r) => ({ ...r }))} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("leaves a settled turn expanded when turnsCollapsed is off", () => {
    const view = render(
      <TurnGroup agentName="Agent" turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />,
      { turnsCollapsed: false },
    );
    expect(view.container.querySelector<HTMLDetailsElement>("details.turn-work")!.open).toBe(true);
  });

  it("keeps a live turn open whichever way turnsCollapsed is set", () => {
    const view = render(
      <TurnGroup agentName="Agent" turnId="u1" rows={liveRows()} renderRow={renderPlainRow} />,
      { turnsCollapsed: true },
    );
    expect(view.container.querySelector<HTMLDetailsElement>("details.turn-work")!.open).toBe(true);
  });

  it("follows a mid-session setting change only on turns the user has not touched", async () => {
    const user = userEvent.setup();
    const view = render(
      <>
        <TurnsCollapsedToggle />
        <TurnGroup agentName="Agent" turnId="u1" rows={settledRows("u1")} renderRow={renderPlainRow} />
        <TurnGroup agentName="Agent" turnId="u2" rows={settledRows("u2")} renderRow={renderPlainRow} />
      </>,
      { turnsCollapsed: true },
    );
    const details = () => [...view.container.querySelectorAll<HTMLDetailsElement>("details.turn-work")];
    expect(details().map((element) => element.open)).toEqual([false, false]);

    await user.click(view.container.querySelectorAll("summary.turn-summary")[0]);
    expect(details().map((element) => element.open)).toEqual([true, false]);

    await user.click(screen.getByRole("button", { name: "flip turnsCollapsed" }));
    expect(details().map((element) => element.open)).toEqual([true, true]);

    // Flipping back proves the split: the untouched turn tracks the default,
    // the one the user expanded keeps its state.
    await user.click(screen.getByRole("button", { name: "flip turnsCollapsed" }));
    expect(details().map((element) => element.open)).toEqual([true, false]);
  });
});

/* The late-subagent bug: a real answer swallowed into the collapsed work block.

   `splitTurn` takes the tail as the maximal SUFFIX of outcome rows, so any
   single non-outcome row near the end hides everything before it. When a
   subagent reports late, its `agent-message` row lands between the assistant's
   real answer and whatever short thing the assistant says next — and the answer,
   which is the whole point of the turn, is collapsed behind "N steps". */
describe("a late agent-message must not bury the answer", () => {
  const rows = [
    prompt("p", "t1"),
    pythonRow("work-1", "t1", "complete"),
    row("answer", { turnId: "t1", text: "I tested it, as you suggested…" }),
    row("late-report", {
      turnId: "t1",
      text: "child reporting in",
      presentation: { kind: "agent-message", sender: "child", relationship: "child" } as TranscriptPresentation,
    }),
    row("followup", { turnId: "t1", text: "Last cleanup confirmation." }),
  ];

  it("keeps the substantive answer visible rather than collapsing it", () => {
    const { work, tail } = splitTurn(rows);
    expect(work.map((r) => r.id)).not.toContain("answer");
    expect(tail.map((r) => r.id)).toContain("answer");
  });

  it("still keeps the trailing follow-up visible", () => {
    expect(splitTurn(rows).tail.map((r) => r.id)).toContain("followup");
  });

  it("does not let an incoming report alone stand in for an outcome", () => {
    // A turn still working: the child has reported, the assistant has not
    // answered yet. Promoting that report to the tail would make the turn look
    // finished and stop showing "Working…".
    const working = [
      prompt("p", "t2"),
      pythonRow("w", "t2", "complete"),
      row("incoming", {
        turnId: "t2",
        presentation: { kind: "agent-message", sender: "child", relationship: "child" } as TranscriptPresentation,
      }),
    ];
    expect(splitTurn(working).tail).toHaveLength(0);
    expect(turnSettled(working)).toBe(false);
  });

  it("collapses a report that sits in the middle of the work", () => {
    const midTurn = [
      prompt("p", "t3"),
      row("mid-report", {
        turnId: "t3",
        presentation: { kind: "agent-message", sender: "child", relationship: "child" } as TranscriptPresentation,
      }),
      pythonRow("after", "t3", "complete"),
      row("answer", { turnId: "t3" }),
    ];
    const { work, tail } = splitTurn(midTurn);
    expect(work.map((r) => r.id)).toEqual(["mid-report", "after"]);
    expect(tail.map((r) => r.id)).toEqual(["answer"]);
  });

});

/* Answers are not collapsed, wherever they sit in the turn.

   Measured against 187 real turns: 36% hid a substantial answer inside the work
   while something shorter stood as the conclusion, median 17x more text hidden
   than shown. A tool call after an answer was enough to bury it, because the
   visible tail can only be the final contiguous run of outcome rows. */
describe("substantive prose is never collapsed", () => {
  const long = (n: number) => "x".repeat(n);

  it("promotes a long answer out of the work and splits the run around it", () => {
    const { segments } = splitTurnSegments([
      prompt("p", "t"),
      pythonRow("w1", "t", "complete"),
      row("answer", { turnId: "t", text: long(VISIBLE_PROSE_CHARS) }),
      pythonRow("w2", "t", "complete"),
      row("final", { turnId: "t", text: "Done." }),
    ]);
    expect(segments.map((s) => [s.kind, s.rows.map((r) => r.id)])).toEqual([
      ["work", ["w1"]],
      ["visible", ["answer"]],
      ["work", ["w2"]],
      ["visible", ["final"]],
    ]);
  });

  it("leaves short narration collapsed, so a turn does not fill with pills", () => {
    const { segments } = splitTurnSegments([
      prompt("p", "t"),
      pythonRow("w1", "t", "complete"),
      row("aside", { turnId: "t", text: long(VISIBLE_PROSE_CHARS - 1) }),
      pythonRow("w2", "t", "complete"),
      row("final", { turnId: "t", text: "Done." }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(["work", "visible"]);
    expect(segments[0].rows.map((r) => r.id)).toEqual(["w1", "aside", "w2"]);
  });

  it("keeps a short closing answer visible however brief it is", () => {
    const { segments } = splitTurnSegments([
      prompt("p", "t"),
      pythonRow("w1", "t", "complete"),
      row("final", { turnId: "t", text: "Yes." }),
    ]);
    expect(segments.at(-1)).toMatchObject({ kind: "visible" });
    expect(segments.at(-1)!.rows.map((r) => r.id)).toEqual(["final"]);
  });

  it("counts only its own rows in each collapsed block", () => {
    // A pill that says "3 steps" and opens onto two of them is describing the
    // turn, not the control the user just tapped.
    const rows = [
      prompt("p", "t"),
      pythonRow("w1", "t", "complete"),
      pythonRow("w2", "t", "complete"),
      row("answer", { turnId: "t", text: "y".repeat(400) }),
      pythonRow("w3", "t", "complete"),
      row("final", { turnId: "t", text: "Done." }),
    ];
    render(
      <TurnGroup agentName="Agent" turnId="t" rows={rows} renderRow={(m) => <p key={m.id}>{m.text}</p>} />,
      { turnsCollapsed: true },
    );
    const summaries = screen.getAllByRole("group").map((d) => d.querySelector(".turn-summary-text")?.textContent);
    expect(summaries[0]).toMatch(/^2 steps/);
    expect(summaries[1]).toMatch(/^1 step\b/);
  });

  it("renders the answer outside any collapsed block", () => {
    const rows = [
      prompt("p", "t"),
      pythonRow("w1", "t", "complete"),
      row("answer", { turnId: "t", text: long(400) }),
      pythonRow("w2", "t", "complete"),
      row("final", { turnId: "t", text: "Done." }),
    ];
    render(
      <TurnGroup agentName="Agent" turnId="t" rows={rows} renderRow={(m) => <p key={m.id} data-testid={m.id}>{m.text}</p>} />,
      { turnsCollapsed: true },
    );
    // Present, and not inside a <details> — the thing the bug got wrong.
    expect(screen.getByTestId("answer").closest("details")).toBeNull();
    expect(screen.getByTestId("final").closest("details")).toBeNull();
    expect(screen.getAllByRole("group").length).toBe(2);
  });
});
