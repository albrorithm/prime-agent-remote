import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { createLowlight } from "lowlight";
import type { RootContent } from "hast";

type Highlighter = ReturnType<typeof createLowlight>;

// Highlighting stays a rendering nicety: past this size the parse cost on a
// phone outweighs the benefit and the block renders as plain text.
const HIGHLIGHT_MAX_CHARS = 50_000;

const REGISTERED_LANGUAGES = ["python", "bash", "json", "diff", "javascript", "typescript", "xml"] as const;

const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  svg: "xml",
  patch: "diff",
  jsonc: "json",
};

export function normalizeHighlightLanguage(lang: string): string | null {
  const lower = lang.trim().toLowerCase();
  if (!lower) return null;
  const canonical = LANGUAGE_ALIASES[lower] ?? lower;
  return (REGISTERED_LANGUAGES as readonly string[]).includes(canonical) ? canonical : null;
}

// One shared instance for every code block on the page; nothing pays the
// grammar download until the first highlightable block appears.
let loadedHighlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter | null> | null = null;

function loadHighlighter(): Promise<Highlighter | null> {
  highlighterPromise ??= (async () => {
    const [lowlight, python, bash, json, diff, javascript, typescript, xml] = await Promise.all([
      import("lowlight"),
      import("highlight.js/lib/languages/python"),
      import("highlight.js/lib/languages/bash"),
      import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/diff"),
      import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/typescript"),
      import("highlight.js/lib/languages/xml"),
    ]);
    const instance = lowlight.createLowlight();
    instance.register({
      python: python.default,
      bash: bash.default,
      json: json.default,
      diff: diff.default,
      javascript: javascript.default,
      typescript: typescript.default,
      xml: xml.default,
    });
    loadedHighlighter = instance;
    return instance;
  })().catch(() => null);
  return highlighterPromise;
}

/**
 * lowlight emits HAST (plain data nodes), rendered here as React elements so
 * highlighted code goes through the same XSS-safe path as everything else —
 * no HTML string ever exists.
 */
function renderHastNodes(nodes: RootContent[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const rawClassName = node.properties?.className;
    const className = Array.isArray(rawClassName) ? rawClassName.join(" ") : undefined;
    const key = `${keyPrefix}-${index}`;
    return (
      <span key={key} className={className}>
        {renderHastNodes(node.children as RootContent[], key)}
      </span>
    );
  });
}

/**
 * Renders code as a `<code>` element, syntax-highlighted once the (lazily
 * loaded) grammars are available. Until then — and for unknown languages —
 * it renders the same plain `<code>` the app always shipped.
 */
export const SyntaxHighlight = memo(function SyntaxHighlight({ lang, code }: { lang: string; code: string }) {
  const language = normalizeHighlightLanguage(lang);
  const [engine, setEngine] = useState<Highlighter | null>(loadedHighlighter);

  useEffect(() => {
    if (engine || !language) return;
    let cancelled = false;
    void loadHighlighter().then((instance) => {
      if (!cancelled && instance) setEngine(instance);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, language]);

  const tree = useMemo(() => {
    if (!engine || !language || code.length > HIGHLIGHT_MAX_CHARS) return null;
    try {
      return engine.highlight(language, code);
    } catch {
      return null;
    }
  }, [engine, language, code]);

  if (!tree) return <code>{code}</code>;
  return <code className="syntax-highlight">{renderHastNodes(tree.children as RootContent[], "hl")}</code>;
});
