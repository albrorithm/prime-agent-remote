import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RefineRow, type RefinePresentation } from "./RefineRow";

function makePresentation(overrides: Partial<RefinePresentation> = {}): RefinePresentation {
  return {
    kind: "refine",
    status: "complete",
    summary: "Refined the continual harness",
    ...overrides,
  };
}

describe("RefineRow", () => {
  it("shows the summary and scope chip when collapsed", () => {
    render(<RefineRow presentation={makePresentation({ scope: "local" })} />);
    expect(screen.getByText("Refined the continual harness")).toBeInTheDocument();
    expect(screen.getByText("local")).toBeInTheDocument();
  });

  it("shows an N-edits disclosure that reveals the edit list on expand", async () => {
    const user = userEvent.setup();
    render(<RefineRow presentation={makePresentation({
      edits: [
        { action: "create", kind: "skill", title: "code-review-checklist", reason: "Repeated review gaps", applied: true },
        { action: "update", kind: "memory", title: "user preferences", reason: "Stale info", applied: true },
      ],
    })} />);

    expect(screen.getByText("2 edits")).toBeInTheDocument();
    const editTitle = screen.getByText(/code-review-checklist/);
    expect(editTitle).not.toBeVisible();

    await user.click(screen.getByText("2 edits"));

    expect(editTitle).toBeVisible();
    expect(screen.getByText("Repeated review gaps")).toBeVisible();
    expect(screen.getByText(/user preferences/)).toBeVisible();
    expect(screen.getByText("Stale info")).toBeVisible();
  });

  it("uses singular wording for exactly one edit", () => {
    render(<RefineRow presentation={makePresentation({
      edits: [{ action: "delete", kind: "prompt", title: "stale-instruction", applied: true }],
    })} />);
    expect(screen.getByText("1 edit")).toBeInTheDocument();
  });

  it("renders no disclosure when there are no edits", () => {
    render(<RefineRow presentation={makePresentation()} />);
    expect(document.querySelector("details")).toBeNull();
    expect(screen.queryByText(/edit/i)).not.toBeInTheDocument();
  });

  it("renders a scope chip for global scope", () => {
    render(<RefineRow presentation={makePresentation({ scope: "global" })} />);
    expect(screen.getByText("global")).toBeInTheDocument();
  });

  it("renders a rollback badge when rollback is true", () => {
    render(<RefineRow presentation={makePresentation({ rollback: true })} />);
    expect(screen.getByText("Rollback")).toBeInTheDocument();
  });

  it("omits the rollback badge when rollback is false or absent", () => {
    render(<RefineRow presentation={makePresentation({ rollback: false })} />);
    expect(screen.queryByText("Rollback")).not.toBeInTheDocument();
  });

  it("applies the failed tone class and shows the error", () => {
    render(<RefineRow presentation={makePresentation({ status: "failed", error: "Harness write denied" })} />);
    expect(screen.getByText("Harness write denied")).toBeInTheDocument();
    expect(document.querySelector(".refine-row.failed")).not.toBeNull();
  });

  it("omits the error paragraph on a non-failed row even if present", () => {
    render(<RefineRow presentation={makePresentation({ status: "complete", error: "should not show" })} />);
    expect(screen.queryByText("should not show")).not.toBeInTheDocument();
  });

  it("shows a spinner and a running label matching the app's streaming idiom", () => {
    render(<RefineRow presentation={makePresentation({ status: "running", summary: "Applying edits" })} />);
    const row = document.querySelector(".refine-row.running");
    expect(row).not.toBeNull();
    expect(row!.querySelector("svg.spin")).not.toBeNull();
    expect(screen.getByText("Refining…")).toBeInTheDocument();
  });

  it("surfaces a per-edit error and an unapplied edit without hiding either", async () => {
    const user = userEvent.setup();
    render(<RefineRow presentation={makePresentation({
      status: "failed",
      edits: [
        { action: "update", kind: "subagent", title: "ws4-refine", applied: false, error: "validation failed" },
      ],
    })} />);
    await user.click(screen.getByText("1 edit"));
    expect(screen.getByText("validation failed")).toBeInTheDocument();
  });
});
