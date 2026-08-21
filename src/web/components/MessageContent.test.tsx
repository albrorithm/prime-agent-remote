import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageContent, parseMessageBlocks, renderInline } from "./MessageContent";

describe("parseMessageBlocks", () => {
  it("splits fenced code from prose", () => {
    const blocks = parseMessageBlocks("Before\n```ts\nconst x = 1;\n```\nAfter");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: "text", text: "Before\n" });
    expect(blocks[1]).toEqual({ kind: "code", lang: "ts", code: "const x = 1;", streaming: false });
    expect(blocks[2]).toEqual({ kind: "text", text: "\nAfter" });
  });

  it("treats an unterminated fence as streaming code", () => {
    const blocks = parseMessageBlocks("Look:\n```python\nprint(1)");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ kind: "code", lang: "python", code: "print(1)", streaming: true });
  });

  it("keeps plain text intact when no fences exist", () => {
    expect(parseMessageBlocks("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });
});

describe("renderInline", () => {
  it("wraps inline code spans", () => {
    const parts = renderInline("run `npm test` now");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatchObject({ props: { children: "npm test" } });
  });
});

describe("MessageContent", () => {
  it("renders a copy button for complete code blocks", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<MessageContent text={"```\nhello()\n```"} />);
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("hello()");
    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  });

  it("hides the copy button while the block is streaming", () => {
    render(<MessageContent text={"```js\nconst a = 1;"} />);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(screen.getByText("writing…")).toBeDefined();
  });
});
