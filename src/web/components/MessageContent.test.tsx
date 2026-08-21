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

  it("formats a pure JSON payload as a code block", () => {
    expect(parseMessageBlocks('{"type":"tool","payload":{"ok":true}}')).toEqual([
      {
        kind: "code",
        lang: "json",
        code: '{\n  "type": "tool",\n  "payload": {\n    "ok": true\n  }\n}',
        streaming: false,
      },
    ]);
  });

  it("leaves malformed JSON as transcript text", () => {
    const text = '{"type":tool}';
    expect(parseMessageBlocks(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("renderInline", () => {
  it("wraps inline code spans", () => {
    const parts = renderInline("run `npm test` now");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatchObject({ props: { children: "npm test" } });
  });

  it("does not format Markdown inside inline code", () => {
    render(<p>{renderInline("`**literal** [link](javascript:alert(1))`")}</p>);
    const code = screen.getByText("**literal** [link](javascript:alert(1))");
    expect(code.tagName).toBe("CODE");
    expect(code.querySelector("strong, a")).toBeNull();
  });
});

describe("MessageContent", () => {
  it("renders headings, lists, quotes, and inline formatting", () => {
    const { container } = render(
      <MessageContent
        text={[
          "## Update",
          "",
          "- **ready**",
          "- *waiting* with ~~old~~ and `value`",
          "",
          "3. third",
          "4. fourth",
          "",
          "> quoted **text**",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Update" })).toBeDefined();
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(container.querySelector("strong")?.textContent).toBe("ready");
    expect(container.querySelector("em")?.textContent).toBe("waiting");
    expect(container.querySelector("del")?.textContent).toBe("old");
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted text");
  });

  it("renders safe links and rejects unsafe schemes", () => {
    const { container } = render(
      <MessageContent
        text={"[docs](https://example.com/docs) [help](/help) [bad](JaVaScRiPt:alert(1)) [data](data:text/html,bad)"}
      />,
    );

    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "help" }).getAttribute("href")).toBe("/help");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "data" })).toBeNull();
    expect(container.textContent).toContain("bad");
    expect(container.textContent).toContain("data");
  });

  it("renders raw HTML as escaped text", () => {
    const { container } = render(<MessageContent text={'<img src=x onerror="alert(1)"> <script>alert(2)</script>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("bounds deeply nested and marker-heavy Markdown", () => {
    const nested = render(<MessageContent text={`${">".repeat(100)} deep quote`} />);
    expect(nested.container.textContent).toContain("deep quote");
    expect(nested.container.querySelectorAll("blockquote").length).toBeLessThanOrEqual(12);
    nested.unmount();

    const markers = render(<MessageContent text={"*".repeat(2_000)} />);
    expect(markers.container.textContent).toHaveLength(2_000);
    expect(markers.container.querySelector("strong, em")).toBeNull();
  });

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
