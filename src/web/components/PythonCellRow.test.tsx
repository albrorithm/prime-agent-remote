import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CellOutput, TranscriptMessage } from "../../protocol";
import { PythonCellRow, type PythonCellPresentation } from "./PythonCellRow";

// The highlighter loads lazily and is exercised in its own suite; here the
// cell row is under test, so code renders as plain text.
vi.mock("./SyntaxHighlight", () => ({
  SyntaxHighlight: ({ code }: { code: string }) => <code>{code}</code>,
}));

function makeMessage(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: "tool-1",
    role: "assistant",
    text: "print(total)",
    state: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePresentation(overrides: Partial<PythonCellPresentation> = {}): PythonCellPresentation {
  return {
    kind: "python",
    lang: "python",
    status: "complete",
    preview: "print(total)",
    code: "total = 1 + 2\nprint(total)",
    ...overrides,
  };
}

describe("PythonCellRow", () => {
  it("renders a collapsed one-line row with label, preview, and meta", () => {
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ meta: "↑2 ↓1 lines · 1.2s", stdout: "3" })}
      />,
    );
    const summary = screen.getByRole("button", { name: "python cell complete: print(total), ↑2 ↓1 lines · 1.2s" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(screen.getByText("↑2 ↓1 lines · 1.2s")).toBeInTheDocument();
    expect(screen.queryByText("stdout")).not.toBeInTheDocument();
    expect(document.querySelector("figure.code-block")).toBeNull();
  });

  it("expands to code plus one labeled section per present output stream", async () => {
    const user = userEvent.setup();
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ stdout: "3\n", result: "None" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));

    expect(screen.getByRole("button", { name: /python cell/ })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("figure.code-block")?.textContent).toContain("total = 1 + 2");
    expect(screen.getByText("stdout")).toBeInTheDocument();
    expect(screen.getByText("result")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    // Streams the cell never produced get no section at all.
    expect(screen.queryByText("stderr")).not.toBeInTheDocument();
    expect(screen.queryByText("traceback")).not.toBeInTheDocument();
  });

  it("notifies onToggle when opened and closed", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<PythonCellRow message={makeMessage()} presentation={makePresentation()} onToggle={onToggle} />);
    const summary = screen.getByRole("button", { name: /python cell/ });
    await user.click(summary);
    expect(onToggle).toHaveBeenLastCalledWith(true);
    await user.click(summary);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it("renders a failed cell with its exception headline and traceback", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({
          status: "failed",
          error: { ename: "ValueError", evalue: "bad total", traceback: "Traceback (most recent call last)\n  ..." },
        })}
      />,
    );
    expect(container.querySelector(".python-cell.failed")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /python cell failed/ }));
    expect(screen.getByText("traceback")).toBeInTheDocument();
    expect(screen.getByText("ValueError: bad total")).toBeInTheDocument();
    expect(screen.getByText(/Traceback \(most recent call last\)/)).toBeInTheDocument();
    expect(container.querySelector(".python-cell-section.danger")).not.toBeNull();
  });

  it("renders unified diffs with a path header and old/new lines", async () => {
    const user = userEvent.setup();
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({
          diffs: [{ path: "src/app.py", oldStr: "x = 1", newStr: "x = 2\ny = 3", startLine: 12 }],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));
    expect(screen.getByText("src/app.py")).toBeInTheDocument();
    expect(screen.getByText("line 12")).toBeInTheDocument();
    expect(screen.getByText("- x = 1")).toBeInTheDocument();
    expect(screen.getByText("+ x = 2")).toBeInTheDocument();
    expect(screen.getByText("+ y = 3")).toBeInTheDocument();
  });

  it("fetches the full cell when a section is truncated and swaps it in", async () => {
    const user = userEvent.setup();
    const fetchCell = vi.fn().mockResolvedValue({
      cellId: "cell-9",
      stdout: "the whole output",
      truncated: false,
    } satisfies CellOutput);
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ stdout: "the whole out…", stdoutTruncated: true, cellId: "cell-9" })}
        fetchCell={fetchCell}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));
    await user.click(screen.getByRole("button", { name: "View full output" }));

    expect(fetchCell).toHaveBeenCalledWith("cell-9");
    await waitFor(() => expect(screen.getByText("the whole output")).toBeInTheDocument());
    expect(screen.queryByText("the whole out…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View full output" })).not.toBeInTheDocument();
  });

  it("notes when even the fetched output remains capped by the server", async () => {
    const user = userEvent.setup();
    const fetchCell = vi.fn().mockResolvedValue({
      cellId: "cell-9",
      stdout: "still capped",
      truncated: true,
    } satisfies CellOutput);
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ stdout: "cap…", stdoutTruncated: true, cellId: "cell-9" })}
        fetchCell={fetchCell}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));
    await user.click(screen.getByRole("button", { name: "View full output" }));
    await waitFor(() => expect(screen.getByText("Some output is still truncated on the server.")).toBeInTheDocument());
  });

  it("surfaces a fetch failure and keeps the action available to retry", async () => {
    const user = userEvent.setup();
    const fetchCell = vi.fn()
      .mockRejectedValueOnce(new Error("The request timed out"))
      .mockResolvedValueOnce({ cellId: "cell-9", stdout: "recovered", truncated: false } satisfies CellOutput);
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ stdout: "sho…", stdoutTruncated: true, cellId: "cell-9" })}
        fetchCell={fetchCell}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));
    await user.click(screen.getByRole("button", { name: "View full output" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The request timed out"));

    await user.click(screen.getByRole("button", { name: "View full output" }));
    await waitFor(() => expect(screen.getByText("recovered")).toBeInTheDocument());
  });

  it("labels truncated output honestly when no cellId is available", async () => {
    const user = userEvent.setup();
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ stdout: "sho…", stdoutTruncated: true })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));
    expect(screen.queryByRole("button", { name: "View full output" })).not.toBeInTheDocument();
    expect(screen.getByText("Output shown is truncated.")).toBeInTheDocument();
  });

  it("keeps the writing idiom while the cell streams", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <PythonCellRow
        message={makeMessage({ state: "streaming" })}
        presentation={makePresentation({ status: "running", code: "total = 1 +" })}
      />,
    );
    expect(container.querySelector(".python-cell.running.streaming")).not.toBeNull();
    expect(container.querySelector(".python-cell-summary .spin")).not.toBeNull();
    expect(screen.getByText("writing…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /python cell running/ }));
    // Summary and the streaming code block caption both carry the idiom.
    expect(screen.getAllByText("writing…")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
  });

  it("shows a kernel-restart notice when the daemon flagged one", async () => {
    const user = userEvent.setup();
    render(
      <PythonCellRow
        message={makeMessage()}
        presentation={makePresentation({ kernelRestarted: true })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /python cell/ }));
    expect(screen.getByText(/Kernel restarted during this cell/)).toBeInTheDocument();
  });
});
