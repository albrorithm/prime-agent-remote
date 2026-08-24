import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentGoal } from "../../protocol";
import { GoalStrip } from "./GoalStrip";

function makeGoal(overrides: Partial<AgentGoal> = {}): AgentGoal {
  return {
    status: "active",
    objective: "Ship the release notes",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationsUsed: 0,
    ...overrides,
  };
}

describe("GoalStrip", () => {
  it("renders nothing when there is no goal", () => {
    const { container } = render(<GoalStrip goal={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the objective and a humanized status label", () => {
    render(<GoalStrip goal={makeGoal({ status: "budget_limited", objective: "Migrate the database" })} />);
    expect(screen.getByText("Migrate the database")).toBeInTheDocument();
    expect(screen.getByText("Budget limited")).toBeInTheDocument();
  });

  it("computes and displays a token budget progress percentage", async () => {
    const user = userEvent.setup();
    render(<GoalStrip goal={makeGoal({ tokenBudget: 1000, tokensUsed: 250, timeUsedSeconds: 90, continuationsUsed: 2 })} />);
    await user.click(screen.getByText("Goal", { exact: false }));

    const progressbar = screen.getByRole("progressbar", { name: "Goal token budget used" });
    expect(progressbar).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("1m")).toBeInTheDocument();
    expect(screen.getByText("2 continuations")).toBeInTheDocument();
  });

  it("omits the progress meter when there is no token budget", () => {
    render(<GoalStrip goal={makeGoal({ tokenBudget: undefined })} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows the last reason and error when present", async () => {
    const user = userEvent.setup();
    render(<GoalStrip goal={makeGoal({ lastReason: "Waiting on CI", lastError: "Timed out" })} />);
    await user.click(screen.getByText("Goal", { exact: false }));
    expect(screen.getByText("Waiting on CI")).toBeInTheDocument();
    expect(screen.getByText("Timed out")).toBeInTheDocument();
  });

  it("uses singular continuation wording for exactly one", async () => {
    const user = userEvent.setup();
    render(<GoalStrip goal={makeGoal({ continuationsUsed: 1 })} />);
    await user.click(screen.getByText("Goal", { exact: false }));
    expect(screen.getByText("1 continuation")).toBeInTheDocument();
  });
});
