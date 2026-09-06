import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionQueue } from "../../protocol";
import { QueueStrip } from "./QueueStrip";

function queue(overrides: Partial<SessionQueue> = {}): SessionQueue {
  return { steering: [], followUp: [], queuedCount: 0, ...overrides };
}

describe("QueueStrip", () => {
  it("renders nothing when Prime holds nothing", () => {
    const { container } = render(<QueueStrip queue={queue()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("tags each row with the lane that will consume it", () => {
    render(<QueueStrip queue={queue({
      steering: [{ text: "look at the diff", truncated: false }],
      followUp: [{ text: "then commit", truncated: false }],
      queuedCount: 2,
    })} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Steering");
    expect(rows[0]).toHaveTextContent("look at the diff");
    expect(rows[1]).toHaveTextContent("After run");
    expect(rows[1]).toHaveTextContent("then commit");
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("marks an entry Prime cut with an ellipsis so it does not read as complete", () => {
    render(<QueueStrip queue={queue({
      steering: [{ text: "the first two thousand characters", truncated: true }],
      queuedCount: 1,
    })} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("the first two thousand characters…");
  });

  it("lists four rows at most and counts everything else", () => {
    render(<QueueStrip queue={queue({
      steering: [
        { text: "one", truncated: false },
        { text: "two", truncated: false },
        { text: "three", truncated: false },
      ],
      followUp: [
        { text: "four", truncated: false },
        { text: "five", truncated: false },
      ],
      // Higher than the two lanes hold: queuedCount also counts session
      // commands the lanes never list, and this is what the count is drawn from.
      queuedCount: 9,
    })} />);

    const strip = screen.getByRole("group", { name: "Queued in Prime, 9" });
    const rows = within(strip).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[3]).toHaveTextContent("four");
    expect(rows[4]).toHaveTextContent("+5 more");
  });

  it("still says how much is held when neither lane lists any of it", () => {
    render(<QueueStrip queue={queue({ queuedCount: 2 })} />);
    expect(screen.getByRole("group", { name: "Queued in Prime, 2" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("+2 more");
  });
});
