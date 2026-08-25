import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptMessage, TranscriptPresentation } from "../../protocol";
import { formatWorkDuration, groupIntoTurns, splitTurn, TurnGroup, turnSettled } from "./TurnGroup";

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
  });
});

describe("TurnGroup", () => {
  function liveRows(turnId = "u1"): TranscriptMessage[] {
    return [prompt("u1", turnId), thinkingRow("t1", turnId), pythonRow("p1", turnId, "running")];
  }

  function settledRows(turnId = "u1"): TranscriptMessage[] {
    return [prompt("u1", turnId), thinkingRow("t1", turnId), pythonRow("p1", turnId, "complete", 420), answer("a1", turnId)];
  }

  it("keeps a live turn's work open, then auto-collapses exactly when the answer lands", () => {
    const view = render(<TurnGroup turnId="u1" rows={liveRows()} renderRow={renderPlainRow} />);
    const details = () => view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details().open).toBe(true);
    expect(screen.getByText("Working… · 2 steps")).toBeInTheDocument();

    view.rerender(<TurnGroup turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    expect(details().open).toBe(false);
    expect(screen.getByText("2 steps · 420ms")).toBeInTheDocument();
  });

  it("keeps the prompt and answer outside the collapsible work region", () => {
    const view = render(<TurnGroup turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
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
    const view = render(<TurnGroup turnId="u1" rows={rows} renderRow={renderPlainRow} />);
    const details = view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-row='e1']")).toBeNull();
    expect(view.container.querySelector("[data-row='e1']")).not.toBeNull();
  });

  it("renders no collapsible region when a turn has no work rows", () => {
    const rows = [prompt("u1", "u1"), answer("a1", "u1")];
    const view = render(<TurnGroup turnId="u1" rows={rows} renderRow={renderPlainRow} />);
    expect(view.container.querySelector("details")).toBeNull();
  });

  it("omits the duration when no work row carries one", () => {
    const rows = [prompt("u1", "u1"), thinkingRow("t1", "u1"), answer("a1", "u1")];
    render(<TurnGroup turnId="u1" rows={rows} renderRow={renderPlainRow} />);
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });

  it("prefers the session recap for a settled turn's summary, keeping the counts as meta", () => {
    render(<TurnGroup turnId="u1" rows={settledRows()} recap="Refactored the cell renderer" renderRow={renderPlainRow} />);
    expect(screen.getByText("Refactored the cell renderer")).toBeInTheDocument();
    expect(screen.getByText("2 steps · 420ms")).toBeInTheDocument();
  });

  it("ignores the recap while the turn is still live", () => {
    render(<TurnGroup turnId="u1" rows={liveRows()} recap="Still working" renderRow={renderPlainRow} />);
    expect(screen.queryByText("Still working")).not.toBeInTheDocument();
    expect(screen.getByText("Working… · 2 steps")).toBeInTheDocument();
  });

  it("lets the user re-expand a settled turn, persisting across re-renders", async () => {
    const user = userEvent.setup();
    const view = render(<TurnGroup turnId="u1" rows={settledRows()} renderRow={renderPlainRow} />);
    const details = () => view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details().open).toBe(false);

    await user.click(view.container.querySelector("summary.turn-summary")!);
    expect(details().open).toBe(true);

    view.rerender(<TurnGroup turnId="u1" rows={settledRows().map((r) => ({ ...r }))} renderRow={renderPlainRow} />);
    expect(details().open).toBe(true);
  });

  it("lets the user collapse a live turn, overriding the auto-open", async () => {
    const user = userEvent.setup();
    const view = render(<TurnGroup turnId="u1" rows={liveRows()} renderRow={renderPlainRow} />);
    const details = () => view.container.querySelector<HTMLDetailsElement>("details.turn-work")!;
    expect(details().open).toBe(true);

    await user.click(view.container.querySelector("summary.turn-summary")!);
    expect(details().open).toBe(false);

    view.rerender(<TurnGroup turnId="u1" rows={liveRows().map((r) => ({ ...r }))} renderRow={renderPlainRow} />);
    expect(details().open).toBe(false);
  });

  it("skips re-rendering a settled turn when a new array carries identical content", () => {
    const renderRow = vi.fn(renderPlainRow);
    const view = render(<TurnGroup turnId="u1" rows={settledRows()} renderRow={renderRow} />);
    const callsAfterMount = renderRow.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    view.rerender(<TurnGroup turnId="u1" rows={settledRows().map((r) => ({ ...r }))} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBe(callsAfterMount);

    const changed = settledRows();
    changed[changed.length - 1] = { ...changed[changed.length - 1], text: "answer a1 (edited)" };
    view.rerender(<TurnGroup turnId="u1" rows={changed} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("always re-renders a live turn so streaming updates come through", () => {
    const renderRow = vi.fn(renderPlainRow);
    const view = render(<TurnGroup turnId="u1" rows={liveRows()} renderRow={renderRow} />);
    const callsAfterMount = renderRow.mock.calls.length;

    view.rerender(<TurnGroup turnId="u1" rows={liveRows().map((r) => ({ ...r }))} renderRow={renderRow} />);
    expect(renderRow.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});
