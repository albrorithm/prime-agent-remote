import { render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsProvider, type Settings } from "../settings";
import { MessageContent, renderInline } from "./MessageContent";

function render(ui: ReactElement, overrides: Partial<Settings> = {}) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...overrides }));
  return renderBare(ui, { wrapper: SettingsProvider });
}

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

  it("uses the math-enabled parser for inline rendering", () => {
    const { container } = render(<p>{renderInline("value \\(x_i\\)")}</p>);
    expect(container.querySelector(".markdown-math-inline")?.textContent).toBe("xᵢ");
    expect(container.textContent).toBe("value xᵢ");
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

  it("renders GFM tables", () => {
    const { container } = render(
      <MessageContent text={"| Name | State |\n| :--- | ---: |\n| build | ready |"} />,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.getAttribute("tabindex")).toBe("0");
    expect(table?.querySelectorAll("thead th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody td")).toHaveLength(2);
    expect(table?.textContent).toContain("build");
    expect((table?.querySelector("th") as HTMLElement).style.textAlign).toBe("left");
  });

  it("renders setext headings and horizontal rules", () => {
    const { container } = render(<MessageContent text={"Heading\n=======\n\n---"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toBeDefined();
    expect(container.querySelector("hr.markdown-hr")).not.toBeNull();
  });

  it("renders autolinks, bare URLs, and safe relative links", () => {
    render(
      <MessageContent
        text={"<https://example.com/angle> https://example.com/bare [help](/help)"}
      />,
    );

    expect(screen.getByRole("link", { name: "https://example.com/angle" }).getAttribute("href"))
      .toBe("https://example.com/angle");
    expect(screen.getByRole("link", { name: "https://example.com/bare" }).getAttribute("href"))
      .toBe("https://example.com/bare");
    expect(screen.getByRole("link", { name: "help" }).getAttribute("href")).toBe("/help");
  });

  it("updates reference links when a later definition changes", () => {
    const view = render(<MessageContent text={"[docs][ref]\n\n[ref]: /one"} />);
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("/one");

    view.rerender(<MessageContent text={"[docs][ref]\n\n[ref]: /two"} />);
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("/two");
  });

  it("rejects unsafe link schemes", () => {
    const { container } = render(
      <MessageContent text={"[label](javascript:alert(1)) [data](data:text/html,bad)"} />,
    );

    expect(screen.queryByRole("link", { name: "label" })).toBeNull();
    expect(screen.queryByRole("link", { name: "data" })).toBeNull();
    expect(container.textContent).toContain("label");
    expect(container.textContent).toContain("data");
  });

  it("renders images as safe links instead of inline images", () => {
    const { container } = render(<MessageContent text={"![diagram](https://example.com/diagram.png)"} />);
    expect(screen.getByRole("link", { name: "diagram" }).getAttribute("href"))
      .toBe("https://example.com/diagram.png");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders four-space nested lists", () => {
    const { container } = render(<MessageContent text={"- parent\n    - child"} />);
    expect(container.querySelector("ul ul")?.textContent).toBe("child");
  });

  it("preserves paragraph blocks inside loose list items", () => {
    const { container } = render(
      <MessageContent text={"- first paragraph\n\n  second paragraph\n- next"} />,
    );
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    const paragraphs = container.querySelectorAll("ul > li:first-child > p");
    expect(paragraphs).toHaveLength(2);
    expect(Array.from(paragraphs, (paragraph) => paragraph.textContent)).toEqual([
      "first paragraph",
      "second paragraph",
    ]);
  });

  it("handles adjacent emphasis markers as nested strong text", () => {
    const { container } = render(<MessageContent text={"****bold****"} />);
    expect(container.querySelector("strong strong")?.textContent).toBe("bold");
  });

  it("renders raw HTML as escaped text", () => {
    const { container } = render(<MessageContent text={'<img src=x onerror="alert(1)"> <script>alert(2)</script>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("handles deeply nested and marker-heavy Markdown through marked", () => {
    const nested = render(<MessageContent text={`${">".repeat(100)} deep quote`} />);
    expect(nested.container.textContent).toContain("deep quote");
    expect(nested.container.querySelectorAll("blockquote")).toHaveLength(100);
    nested.unmount();

    const markerHeavy = Array.from({ length: 160 }, (_, index) => `**word${index}**`).join(" ");
    const markers = render(<MessageContent text={markerHeavy} />);
    expect(markers.container.querySelectorAll("strong")).toHaveLength(160);
    expect(markers.container.textContent).toContain("word159");
  });

  it("renders display math delimiters as Unicode blocks", () => {
    const { container } = render(
      <MessageContent
        text={"Intro:\n\n\\[\ny_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}\n\\]\n\n$$\nE = mc^2\n$$"}
      />,
    );
    const blocks = container.querySelectorAll(".markdown-math-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].textContent).toBe("yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ");
    expect(blocks[1].textContent).toBe("E = mc²");
    expect(container.textContent).not.toContain("\\sum");
  });

  it("renders inline math without treating dollar amounts as formulas", () => {
    const { container } = render(
      <MessageContent
        text={"weights \\(w_k\\) and $x_i \\cdot y$; between $5 and $10 total; prices $5,$10 listed"}
      />,
    );
    const inline = container.querySelectorAll(".markdown-math-inline");
    expect(inline).toHaveLength(2);
    expect(Array.from(inline, (node) => node.textContent)).toEqual(["wₖ", "xᵢ · y"]);
    expect(container.textContent).toContain("between $5 and $10 total");
    expect(container.textContent).toContain("prices $5,$10 listed");
  });

  it("keeps unterminated display math plain until it closes", () => {
    const view = render(<MessageContent text={"$$\ny_t = \\sum"} />);
    expect(view.container.querySelector(".markdown-math-block")).toBeNull();
    expect(view.container.textContent).toContain("$$");
    expect(view.container.textContent).toContain("\\sum");

    view.rerender(<MessageContent text={"$$\ny_t = \\sum_{k=1}^{n} k\n$$"} />);
    expect(view.container.querySelector(".markdown-math-block")?.textContent).toBe("yₜ = ∑ₖ₌₁ⁿ k");
    expect(view.container.textContent).not.toContain("\\sum");
  });

  it("renders inline and display math inside list items", () => {
    const { container } = render(
      <MessageContent
        text={"- gradient \\(\\nabla_\\theta J\\) step\n- energy:\n\n  $$\n  E = mc^2\n  $$"}
      />,
    );
    expect(container.querySelector("ul")?.textContent).toContain("gradient ∇_θ J step");
    expect(container.querySelector("ul .markdown-math-block")?.textContent).toBe("E = mc²");
  });

  it("renders display math inside an ordered loose list", () => {
    const { container } = render(
      <MessageContent
        text={"1. The sum:\n\n   \\[\n   \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n   \\]\n\n2. Next item"}
      />,
    );
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("ol .markdown-math-block")?.textContent).toBe("∑ₖ₌₁ⁿ k = (n(n+1))/2");
    expect(container.textContent).toContain("Next item");
  });

  it("recognizes four-space-indented and CRLF display math", () => {
    const { container } = render(
      <MessageContent text={"    \\[\r\n    E = mc^2\r\n    \\]\r\n"} />,
    );
    expect(container.querySelector(".markdown-math-block")?.textContent).toBe("E = mc²");
    expect(container.querySelector("figure.code-block")).toBeNull();
  });

  it("keeps ordinary four-space-indented text as code", () => {
    const { container } = render(
      <MessageContent text={"Code:\n\n    const x = 1;\n    return x;"} />,
    );
    expect(container.querySelector("figure.code-block")?.textContent).toContain("const x = 1;");
    expect(container.querySelector(".markdown-math-block, .markdown-math-inline")).toBeNull();
  });

  it("leaves math delimiters inside code untouched", () => {
    const { container } = render(
      <MessageContent text={"run `$x_i$` now\n\n```latex\n\\[\nE = mc^2\n\\]\n```"} />,
    );
    expect(container.querySelector(".inline-code")?.textContent).toBe("$x_i$");
    expect(container.querySelector("figure.code-block")?.textContent).toContain("E = mc^2");
    expect(container.querySelector(".markdown-math-block, .markdown-math-inline")).toBeNull();
  });

  it("joins multiline inline math with spaces", () => {
    const { container } = render(<MessageContent text={"a \\(x +\ny\\) b"} />);
    expect(container.querySelector(".markdown-math-inline")?.textContent).toBe("x + y");
    expect(container.textContent).toBe("a x + y b");
  });

  it("renders JSON as prose instead of an automatic code block", () => {
    const text = '{"type":"tool"}';
    const { container } = render(<MessageContent text={text} />);
    expect(container.querySelector("p")?.textContent).toBe(text);
    expect(container.querySelector("figure.code-block")).toBeNull();
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

  it("renders a completed message with an unclosed fence as finished, not stuck writing", () => {
    // A message the server has already marked complete can still contain an
    // odd number of ``` fences (the model's own output legitimately included
    // or truncated one). Completion must come from the caller's `complete`
    // flag, not be re-derived from fence balance, or the UI shows "writing…"
    // forever and never offers Copy.
    render(<MessageContent text={"Before\n```js\nconst a = 1;"} complete />);
    expect(screen.queryByText("writing…")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
  });
  it("keeps fenced code inside its ordered list container", () => {
    const { container } = render(
      <MessageContent text={"1. Do this:\n\n   ```js\n   work()\n   ```\n\n2. Continue"} />,
    );
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("ol > li:first-child figure.code-block")?.textContent).toContain("work()");
    expect(container.querySelector("ol > li:last-child")?.textContent).toContain("Continue");
  });

  it("marks unterminated fenced code as streaming inside lists and blockquotes", () => {
    const list = render(<MessageContent text={"- Work:\n\n  ```ts\n  const value = 1;"} />);
    expect(list.container.querySelector("ul > li figure.code-block")?.textContent).toContain("writing…");
    expect(list.container.querySelector("ul > li figure button")).toBeNull();
    list.unmount();

    const quote = render(<MessageContent text={"> ```sh\n> npm test"} />);
    expect(quote.container.querySelector("blockquote figure.code-block")?.textContent).toContain("writing…");
    expect(quote.container.querySelector("blockquote figure button")).toBeNull();
  });

  it("renders accessible GFM task checkboxes", () => {
    render(<MessageContent text={"- [x] done\n- [ ] todo"} />);
    const completed = screen.getByRole("checkbox", { name: "Completed task" });
    const incomplete = screen.getByRole("checkbox", { name: "Incomplete task" });
    expect(completed).toBeChecked();
    expect(incomplete).not.toBeChecked();
    expect(completed).toBeDisabled();
    expect(incomplete).toBeDisabled();
  });

  it("classifies noncanonical absolute web URLs by parsed origin", () => {
    render(<MessageContent text={"[external](https:evil.example/path) [local](/help)"} />);
    expect(screen.getByRole("link", { name: "external" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "external" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "local" })).not.toHaveAttribute("target");
  });

  it("renders the body verbatim when rawMarkdown is on, bypassing marked and LaTeX", () => {
    const text = "# Heading\n\n**bold** `code`\n\n$$E = mc^2$$\n\n```ts\nconst x = 1;\n```";
    const { container } = render(<MessageContent text={text} />, { rawMarkdown: true });
    expect(container.querySelector("[data-raw-markdown]")!.textContent).toBe(text);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector(".code-block")).toBeNull();
    // latexToUnicode would have turned this into mc².
    expect(container.textContent).toContain("mc^2");
  });

  it("parses markdown again once rawMarkdown is off", () => {
    const { container } = render(<MessageContent text={"# Heading\n\n**bold**"} />, { rawMarkdown: false });
    expect(container.querySelector("[data-raw-markdown]")).toBeNull();
    expect(container.querySelector("h1")!.textContent).toBe("Heading");
    expect(container.querySelector("strong")!.textContent).toBe("bold");
  });

  it("marks code blocks for soft wrapping only when codeWrap is on", () => {
    const wrapped = render(<MessageContent text={"```\nhello()\n```"} />, { codeWrap: true });
    expect(wrapped.container.querySelector(".code-block code")!.getAttribute("data-wrap")).toBe("true");
    wrapped.unmount();

    const scrolling = render(<MessageContent text={"```\nhello()\n```"} />, { codeWrap: false });
    expect(scrolling.container.querySelector(".code-block code")!.hasAttribute("data-wrap")).toBe(false);
  });

});
