import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { normalizeHighlightLanguage, SyntaxHighlight } from "./SyntaxHighlight";

describe("normalizeHighlightLanguage", () => {
  it("maps aliases onto the registered grammar set", () => {
    expect(normalizeHighlightLanguage("py")).toBe("python");
    expect(normalizeHighlightLanguage("Python")).toBe("python");
    expect(normalizeHighlightLanguage("sh")).toBe("bash");
    expect(normalizeHighlightLanguage("ts")).toBe("typescript");
    expect(normalizeHighlightLanguage("html")).toBe("xml");
  });

  it("returns null for unknown or empty languages", () => {
    expect(normalizeHighlightLanguage("")).toBeNull();
    expect(normalizeHighlightLanguage("   ")).toBeNull();
    expect(normalizeHighlightLanguage("brainfuck")).toBeNull();
  });
});

describe("SyntaxHighlight", () => {
  // This case must run before any other render resolves the lazy grammars:
  // the first paint is always the plain fallback because nothing is loaded yet.
  it("renders plain code until the lazily loaded grammars arrive", async () => {
    const { container } = render(<SyntaxHighlight lang="python" code={'def greet():\n    return "hi"'} />);
    const plain = container.querySelector("code");
    expect(plain).not.toBeNull();
    expect(plain!.querySelector("span")).toBeNull();
    expect(plain!.textContent).toBe('def greet():\n    return "hi"');

    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
    // Highlighting only wraps text in spans; the code itself is unchanged.
    expect(container.querySelector("code")!.textContent).toBe('def greet():\n    return "hi"');
  });

  it("highlights alias languages once loaded", async () => {
    const { container } = render(<SyntaxHighlight lang="py" code="import os" />);
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
  });

  it("keeps unknown languages as plain code", async () => {
    const { container } = render(<SyntaxHighlight lang="brainfuck" code="+++[->+<]" />);
    // Give any stray load a chance to settle; the output must stay plain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector("span")).toBeNull();
    expect(container.querySelector("code")!.textContent).toBe("+++[->+<]");
  });

  it("never interprets code content as markup", async () => {
    const hostile = 'x = "<img src=x onerror=alert(1)><script>alert(2)</script>"';
    const { container } = render(<SyntaxHighlight lang="python" code={hostile} />);
    await waitFor(() => expect(container.querySelector(".hljs-string")).not.toBeNull());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("code")!.textContent).toBe(hostile);
  });

  it("skips highlighting for oversized blocks", async () => {
    const huge = `x = 1\n`.repeat(10_000);
    const { container } = render(<SyntaxHighlight lang="python" code={huge} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector("span")).toBeNull();
  });
});
