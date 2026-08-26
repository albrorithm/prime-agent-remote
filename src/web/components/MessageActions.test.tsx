import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions, shareSupported } from "./MessageActions";

function stubClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

describe("MessageActions", () => {
  it("renders nothing for an empty message", () => {
    const { container } = render(<MessageActions text="" label="Hello" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("copies the exact message text and announces the result", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<MessageActions text="one `two` three" label="Hello" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeText).toHaveBeenCalledWith("one `two` three");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("survives a denied clipboard without breaking the row", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<MessageActions text="body" label="Hello" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument());
  });

  it("hides Share until the platform provides it", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    expect(shareSupported()).toBe(false);
    const { unmount } = render(<MessageActions text="body" label="Hello" />);
    expect(screen.queryByRole("button", { name: "Share message" })).toBeNull();
    unmount();

    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<MessageActions text="body" label="Hello" />);
    await userEvent.click(screen.getByRole("button", { name: "Share message" }));
    expect(share).toHaveBeenCalledWith({ text: "body" });
  });

  it("names the group after the speaker so screen readers can tell rows apart", () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<MessageActions text="body" label="Hello" />);
    expect(screen.getByRole("group", { name: "Hello message actions" })).toBeInTheDocument();
  });
});
