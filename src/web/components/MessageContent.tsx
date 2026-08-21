import { Check, Copy } from "lucide-react";
import { useState, type ReactElement } from "react";

export interface TextBlock {
  kind: "text";
  text: string;
}

export interface CodeBlockModel {
  kind: "code";
  lang: string;
  code: string;
  streaming: boolean;
}

export type MessageBlock = TextBlock | CodeBlockModel;

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const JSON_BLOCK_MAX_CHARS = 20_000;
const MARKDOWN_PARSE_MAX_CHARS = 50_000;
const MARKDOWN_MARKER_MAX_COUNT = 512;
const MAX_MARKDOWN_NESTING = 12;

function appendTextBlock(blocks: MessageBlock[], text: string): void {
  const candidate = text.trim();
  if (
    candidate.length > 1 &&
    candidate.length <= JSON_BLOCK_MAX_CHARS &&
    ((candidate.startsWith("{") && candidate.endsWith("}")) ||
      (candidate.startsWith("[") && candidate.endsWith("]")))
  ) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      blocks.push({ kind: "code", lang: "json", code: JSON.stringify(parsed, null, 2), streaming: false });
      return;
    } catch {
      // Invalid JSON remains ordinary transcript text.
    }
  }
  blocks.push({ kind: "text", text });
}

export function parseMessageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let index = 0;
  FENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_PATTERN.exec(text))) {
    if (match.index > index) appendTextBlock(blocks, text.slice(index, match.index));
    blocks.push({ kind: "code", lang: match[1].trim(), code: match[2].replace(/\n$/, ""), streaming: false });
    index = FENCE_PATTERN.lastIndex;
  }
  const remainder = text.slice(index);
  if (!remainder) return blocks;
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    const openIndex = remainder.indexOf("```");
    if (openIndex > 0) appendTextBlock(blocks, remainder.slice(0, openIndex));
    const afterTicks = remainder.slice(openIndex + 3);
    const newline = afterTicks.indexOf("\n");
    const lang = newline >= 0 ? afterTicks.slice(0, newline).trim() : "";
    const code = newline >= 0 ? afterTicks.slice(newline + 1) : "";
    blocks.push({ kind: "code", lang, code, streaming: true });
  } else {
    appendTextBlock(blocks, remainder);
  }
  return blocks;
}

type InlinePart = string | ReactElement;

const ESCAPABLE_MARKDOWN = new Set("\\`*{}[]()#+-.!_>~|".split(""));
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findExactRun(text: string, character: string, length: number, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== character || isEscaped(text, index)) continue;
    let runLength = 1;
    while (text[index + runLength] === character) runLength += 1;
    if (runLength === length) return index;
    index += runLength - 1;
  }
  return -1;
}

function findFormattingClose(text: string, marker: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const candidate = findExactRun(text, marker[0], marker.length, index);
    if (candidate < 0) return -1;
    if (candidate > from && !/\s/.test(text[candidate - 1])) return candidate;
    index = candidate + marker.length;
  }
  return -1;
}

function unescapeMarkdown(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length && ESCAPABLE_MARKDOWN.has(value[index + 1])) {
      result += value[index + 1];
      index += 1;
    } else {
      result += value[index];
    }
  }
  return result;
}

function safeLinkHref(destination: string): string | null {
  const href = destination.trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href) || href.includes("\\")) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
  if (scheme && !SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return href;
}

interface ParsedLink {
  label: string;
  href: string;
  title?: string;
  end: number;
}

function parseLinkTarget(rawTarget: string): { href: string; title?: string } | null {
  const target = rawTarget.trim();
  const angleMatch = /^<([^<>]*)>(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?$/.exec(target);
  const plainMatch = /^(\S+?)(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?$/.exec(target);
  const match = angleMatch ?? plainMatch;
  if (!match) return null;
  return {
    href: unescapeMarkdown(match[1]),
    title: match[2] ?? match[3],
  };
}

function parseLinkAt(text: string, start: number): ParsedLink | null {
  if (text[start] !== "[") return null;
  let bracketDepth = 1;
  let labelEnd = -1;
  for (let index = start + 1; index < text.length; index += 1) {
    if (isEscaped(text, index)) continue;
    if (text[index] === "[") bracketDepth += 1;
    if (text[index] === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        labelEnd = index;
        break;
      }
    }
  }
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;

  let parenthesisDepth = 1;
  let targetEnd = -1;
  for (let index = labelEnd + 2; index < text.length; index += 1) {
    if (isEscaped(text, index)) continue;
    if (text[index] === "(") parenthesisDepth += 1;
    if (text[index] === ")") {
      parenthesisDepth -= 1;
      if (parenthesisDepth === 0) {
        targetEnd = index;
        break;
      }
    }
  }
  if (targetEnd < 0) return null;
  const target = parseLinkTarget(text.slice(labelEnd + 2, targetEnd));
  if (!target) return null;
  return {
    label: text.slice(start + 1, labelEnd),
    href: target.href,
    title: target.title,
    end: targetEnd + 1,
  };
}

function appendInlineText(parts: InlinePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (typeof previous === "string") parts[parts.length - 1] = previous + value;
  else parts.push(value);
}

function renderInlineInternal(text: string, keyPrefix: string, allowLinks: boolean, depth = 0): InlinePart[] {
  if (depth >= MAX_MARKDOWN_NESTING) return [unescapeMarkdown(text)];
  const parts: InlinePart[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];

    if (character === "\\" && index + 1 < text.length && ESCAPABLE_MARKDOWN.has(text[index + 1])) {
      appendInlineText(parts, text[index + 1]);
      index += 2;
      continue;
    }

    if (character === "`") {
      let runLength = 1;
      while (text[index + runLength] === "`") runLength += 1;
      const close = findExactRun(text, "`", runLength, index + runLength);
      if (close > index + runLength) {
        const code = text.slice(index + runLength, close).replace(/\n/g, " ");
        parts.push(<code key={`${keyPrefix}-code-${index}`} className="inline-code">{code}</code>);
        index = close + runLength;
        continue;
      }
    }

    if (allowLinks && character === "[") {
      const link = parseLinkAt(text, index);
      if (link) {
        const label = renderInlineInternal(link.label, `${keyPrefix}-link-${index}`, false, depth + 1);
        const href = safeLinkHref(link.href);
        if (href) {
          const external = /^(?:https?:)?\/\//i.test(href);
          parts.push(
            <a
              key={`${keyPrefix}-link-${index}`}
              className="markdown-link"
              href={href}
              title={link.title}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
              data-gesture-exclusion
            >
              {label}
            </a>,
          );
        } else {
          for (const labelPart of label) {
            if (typeof labelPart === "string") appendInlineText(parts, labelPart);
            else parts.push(labelPart);
          }
        }
        index = link.end;
        continue;
      }
    }

    const tripleMarker = text.startsWith("***", index)
      ? "***"
      : text.startsWith("___", index)
        ? "___"
        : null;
    if (tripleMarker && !/\s/.test(text[index + 3] ?? "")) {
      const close = findFormattingClose(text, tripleMarker, index + 3);
      if (close > index + 3) {
        parts.push(
          <strong key={`${keyPrefix}-strong-em-${index}`}>
            <em>{renderInlineInternal(text.slice(index + 3, close), `${keyPrefix}-strong-em-${index}`, allowLinks, depth + 1)}</em>
          </strong>,
        );
        index = close + 3;
        continue;
      }
    }

    const strongMarker = text.startsWith("**", index)
      ? "**"
      : text.startsWith("__", index)
        ? "__"
        : null;
    if (strongMarker && text[index + 2] !== strongMarker[0] && !/\s/.test(text[index + 2] ?? "")) {
      const close = findFormattingClose(text, strongMarker, index + 2);
      if (close > index + 2) {
        parts.push(
          <strong key={`${keyPrefix}-strong-${index}`}>
            {renderInlineInternal(text.slice(index + 2, close), `${keyPrefix}-strong-${index}`, allowLinks, depth + 1)}
          </strong>,
        );
        index = close + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index) && text[index + 2] !== "~" && !/\s/.test(text[index + 2] ?? "")) {
      const close = findFormattingClose(text, "~~", index + 2);
      if (close > index + 2) {
        parts.push(
          <del key={`${keyPrefix}-del-${index}`}>
            {renderInlineInternal(text.slice(index + 2, close), `${keyPrefix}-del-${index}`, allowLinks, depth + 1)}
          </del>,
        );
        index = close + 2;
        continue;
      }
    }

    if ((character === "*" || character === "_") && text[index + 1] !== character && !/\s/.test(text[index + 1] ?? "")) {
      const intrawordUnderscore = character === "_" && /[A-Za-z0-9]/.test(text[index - 1] ?? "");
      const close = intrawordUnderscore ? -1 : findFormattingClose(text, character, index + 1);
      if (close > index + 1) {
        parts.push(
          <em key={`${keyPrefix}-em-${index}`}>
            {renderInlineInternal(text.slice(index + 1, close), `${keyPrefix}-em-${index}`, allowLinks, depth + 1)}
          </em>,
        );
        index = close + 1;
        continue;
      }
    }

    appendInlineText(parts, character);
    index += 1;
  }
  return parts;
}

export function renderInline(text: string): Array<string | ReactElement> {
  return renderInlineInternal(text, "inline", true);
}

interface ListItemMatch {
  ordered: boolean;
  number: number;
  text: string;
}

function matchListItem(line: string): ListItemMatch | null {
  const unordered = /^ {0,3}[-+*][ \t]+(.*)$/.exec(line);
  if (unordered) return { ordered: false, number: 1, text: unordered[1] };
  const ordered = /^ {0,3}(\d+)[.)][ \t]+(.*)$/.exec(line);
  if (ordered) return { ordered: true, number: Number.parseInt(ordered[1], 10), text: ordered[2] };
  return null;
}

function matchHeading(line: string): { level: number; text: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!match) return null;
  return {
    level: match[1].length,
    text: (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, ""),
  };
}

function renderHeading(level: number, text: string, key: string): ReactElement {
  const className = `markdown-heading markdown-heading-${level}`;
  const content = renderInlineInternal(text, `${key}-inline`, true);
  switch (level) {
    case 1: return <h1 key={key} className={className}>{content}</h1>;
    case 2: return <h2 key={key} className={className}>{content}</h2>;
    case 3: return <h3 key={key} className={className}>{content}</h3>;
    case 4: return <h4 key={key} className={className}>{content}</h4>;
    case 5: return <h5 key={key} className={className}>{content}</h5>;
    default: return <h6 key={key} className={className}>{content}</h6>;
  }
}

function renderMarkdownBlocks(text: string, keyPrefix: string, quoteDepth = 0): ReactElement[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const elements: ReactElement[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const heading = matchHeading(lines[index]);
    if (heading) {
      elements.push(renderHeading(heading.level, heading.text, `${keyPrefix}-heading-${index}`));
      index += 1;
      continue;
    }

    const quote = /^ {0,3}>[ \t]?(.*)$/.exec(lines[index]);
    if (quote && quoteDepth < MAX_MARKDOWN_NESTING) {
      const quoteLines: string[] = [];
      const start = index;
      while (index < lines.length) {
        const line = /^ {0,3}>[ \t]?(.*)$/.exec(lines[index]);
        if (!line) break;
        quoteLines.push(line[1]);
        index += 1;
      }
      elements.push(
        <blockquote key={`${keyPrefix}-quote-${start}`} className="markdown-blockquote">
          {renderMarkdownBlocks(quoteLines.join("\n"), `${keyPrefix}-quote-${start}`, quoteDepth + 1)}
        </blockquote>,
      );
      continue;
    }

    const firstListItem = matchListItem(lines[index]);
    if (firstListItem) {
      const items: ListItemMatch[] = [];
      const start = index;
      while (index < lines.length) {
        const item = matchListItem(lines[index]);
        if (!item || item.ordered !== firstListItem.ordered) break;
        items.push(item);
        index += 1;
      }
      const listItems = items.map((item, itemIndex) => (
        <li key={`${keyPrefix}-list-${start}-${itemIndex}`}>
          {renderInlineInternal(item.text, `${keyPrefix}-list-${start}-${itemIndex}`, true)}
        </li>
      ));
      elements.push(firstListItem.ordered ? (
        <ol
          key={`${keyPrefix}-list-${start}`}
          className="markdown-list markdown-list-ordered"
          start={firstListItem.number === 1 ? undefined : firstListItem.number}
        >
          {listItems}
        </ol>
      ) : (
        <ul key={`${keyPrefix}-list-${start}`} className="markdown-list markdown-list-unordered">
          {listItems}
        </ul>
      ));
      continue;
    }

    const paragraphLines: string[] = [];
    const start = index;
    while (index < lines.length && lines[index].trim()) {
      if (paragraphLines.length > 0 && (matchHeading(lines[index]) || matchListItem(lines[index]) || /^ {0,3}>/.test(lines[index]))) {
        break;
      }
      paragraphLines.push(lines[index]);
      index += 1;
    }
    elements.push(
      <p key={`${keyPrefix}-paragraph-${start}`} className="markdown-paragraph">
        {renderInlineInternal(paragraphLines.join("\n"), `${keyPrefix}-paragraph-${start}`, true)}
      </p>,
    );
  }

  return elements;
}

function MarkdownProse({ text }: { text: string }) {
  const markerCount = text.match(/[*_~`\[\]]/g)?.length ?? 0;
  const tooComplex = markerCount > MARKDOWN_MARKER_MAX_COUNT || (text.length > 10_000 && markerCount > 64);
  if (text.length > MARKDOWN_PARSE_MAX_CHARS || tooComplex) return <p className="markdown-paragraph">{text}</p>;
  return <>{renderMarkdownBlocks(text, "markdown")}</>;
}

function CodeBlockView({ block }: { block: CodeBlockModel }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail; the text remains selectable.
    }
  }
  return (
    <figure className="code-block" data-gesture-exclusion>
      <figcaption className="code-block-bar">
        <span>{block.lang || "code"}</span>
        {block.streaming ? (
          <span className="code-streaming">writing…</span>
        ) : (
          <button onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy code"} disabled={copied}>
            {copied ? <Check /> : <Copy />}
          </button>
        )}
      </figcaption>
      <pre><code>{block.code}</code></pre>
    </figure>
  );
}

export function MessageContent({ text }: { text: string }) {
  const blocks = parseMessageBlocks(text);
  if (!blocks.length) return null;
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <CodeBlockView key={index} block={block} />
        ) : (
          <MarkdownProse key={index} text={block.text} />
        ),
      )}
    </>
  );
}
