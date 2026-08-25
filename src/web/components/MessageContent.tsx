import { Check, Copy } from "lucide-react";
import { memo, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Marked, Tokenizer, type Token, type TokenizerExtension, type Tokens } from "marked";
import { latexToUnicode } from "../latex";
import { SyntaxHighlight } from "./SyntaxHighlight";

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

type Segment = (TextBlock | CodeBlockModel) & { start: number };

const FENCE_OPENER = /^( {0,3})(`{3,}|~{3,})(.*)\r?$/;
// Keep streaming model output from repeatedly running an unbounded Markdown
// parse on mobile. Longer output stays readable as plain text.
const MARKDOWN_PARSE_MAX_CHARS = 64_000;
const FENCE_SCAN_MAX_CHARS = 250_000;

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
  override del(src: string): Tokens.Del | undefined {
    const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
    if (!match) return undefined;
    return {
      type: "del",
      raw: match[0],
      text: match[2],
      tokens: this.lexer.inlineTokens(match[2]),
    };
  }
}

interface MathToken {
  type: "blockMath" | "inlineMath";
  raw: string;
  text: string;
}

// Math must tokenize before marked's escape/emphasis handling, or \[ collapses
// to [ and underscores inside formulas become italics. Unterminated delimiters
// stay plain text until their closing delimiter arrives.
const BLOCK_MATH_REGEX = /^[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;

function minIndex(a: number, b: number): number | undefined {
  if (a === -1) return b === -1 ? undefined : b;
  return b === -1 ? a : Math.min(a, b);
}

const blockMathExtension: TokenizerExtension = {
  name: "blockMath",
  level: "block",
  start: (src: string) => {
    const paragraphEnd = src.indexOf("\n\n");
    const window = paragraphEnd === -1 ? src : src.slice(0, paragraphEnd);
    return minIndex(window.indexOf("$$"), window.indexOf("\\["));
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const first = src.charCodeAt(0);
    if (first !== 0x24 && first !== 0x5c && first !== 0x20 && first !== 0x09) return undefined;
    const match = BLOCK_MATH_REGEX.exec(src);
    if (!match) return undefined;
    const token: MathToken = { type: "blockMath", raw: match[0], text: (match[1] ?? match[2]).trim() };
    return token;
  },
};

const INLINE_MATH_PATTERNS = [
  /^\$\$([\s\S]+?)\$\$/,
  /^\\\[([\s\S]+?)\\\]/,
  /^\\\(([\s\S]+?)\\\)/,
  /^\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/,
];

const inlineMathExtension: TokenizerExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src: string) => {
    const index = src.indexOf("$");
    return index === -1 ? undefined : index;
  },
  tokenizer(src: string): Tokens.Generic | undefined {
    const first = src.charCodeAt(0);
    if (first !== 0x24 && first !== 0x5c) return undefined;
    for (const pattern of INLINE_MATH_PATTERNS) {
      const match = pattern.exec(src);
      if (match) {
        const token: MathToken = { type: "inlineMath", raw: match[0], text: match[1].trim() };
        return token;
      }
    }
    return undefined;
  },
};

const markdownParser = new Marked();
markdownParser.setOptions({ gfm: true, tokenizer: new StrictStrikethroughTokenizer() });

// Registered extensions slow lexing even when they do not match, so ordinary
// prose keeps the extension-free parser used by the rest of the transcript.
const mathMarkdownParser = new Marked();
mathMarkdownParser.setOptions({ gfm: true, tokenizer: new StrictStrikethroughTokenizer() });
mathMarkdownParser.use({ extensions: [blockMathExtension, inlineMathExtension] });

function pickMarkdownParser(text: string): Marked {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[")
    ? mathMarkdownParser
    : markdownParser;
}

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function safeLinkHref(destination: string): string | null {
  const href = destination.trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href) || href.includes("\\")) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
  if (scheme && !SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return href;
}

function isExternalWebHref(href: string): boolean {
  try {
    const base = typeof window === "undefined" ? "http://localhost/" : window.location.href;
    const target = new URL(href, base);
    const current = new URL(base);
    return (target.protocol === "http:" || target.protocol === "https:")
      && target.origin !== current.origin;
  } catch {
    // safeLinkHref already rejects malformed schemes. If URL parsing still
    // fails, avoid opening a new browsing context.
    return false;
  }
}

function closeFencePattern(character: string, length: number): RegExp {
  return new RegExp(`^ {0,3}${character}{${length},}[ \t]*\r?$`);
}

/**
 * Split message text into fenced code blocks and prose runs.
 * Fences are recognized only at line starts (CommonMark), so a ``` run
 * inside a code body or mid-line never terminates a block early.
 */
function parseSegments(text: string): Segment[] {
  if (text.length > FENCE_SCAN_MAX_CHARS) {
    return [{ kind: "text", text, start: 0 }];
  }
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const segments: Segment[] = [];
  let proseStart: number | null = 0;
  let index = 0;
  while (index < lines.length) {
    const opener = FENCE_OPENER.exec(lines[index]);
    // A backtick fence's info string cannot contain backticks; such lines are prose.
    const validOpener = Boolean(opener && !(opener[2][0] === "`" && opener[3].includes("`")));
    if (!validOpener) {
      if (proseStart === null) proseStart = lineStarts[index];
      index += 1;
      continue;
    }
    if (proseStart !== null && proseStart !== lineStarts[index]) {
      segments.push({ kind: "text", text: text.slice(proseStart, lineStarts[index]), start: proseStart });
    }
    const openerIndent = opener![1].length;
    const fenceCharacter = opener![2][0];
    const fenceLength = opener![2].length;
    const info = opener![3].trim();
    const lang = info.split(/\s+/)[0] ?? "";

    let closeIndex = -1;
    const closer = closeFencePattern(fenceCharacter, fenceLength);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (closer.test(lines[cursor])) {
        closeIndex = cursor;
        break;
      }
    }
    const start = lineStarts[index];
    const codeEnd = closeIndex < 0 ? lines.length : closeIndex;
    const code = lines
      .slice(index + 1, codeEnd)
      .map((line) => {
        let remove = 0;
        while (remove < openerIndent && line[remove] === " ") remove += 1;
        return line.slice(remove);
      })
      .join("\n");
    if (closeIndex < 0) {
      segments.push({ kind: "code", lang, code, streaming: true, start });
      return segments;
    }
    segments.push({ kind: "code", lang, code, streaming: false, start });
    // Preserve the newline after the closing fence as prose, matching the
    // previous parseMessageBlocks contract and keeping source offsets exact.
    proseStart = lineStarts[closeIndex] + lines[closeIndex].length;
    index = closeIndex + 1;
  }
  if (proseStart !== null && proseStart < text.length) {
    segments.push({ kind: "text", text: text.slice(proseStart), start: proseStart });
  }
  return segments;
}

export function parseMessageBlocks(text: string): MessageBlock[] {
  return parseSegments(text).map((segment) =>
    segment.kind === "code"
      ? { kind: segment.kind, lang: segment.lang, code: segment.code, streaming: segment.streaming }
      : { kind: segment.kind, text: segment.text },
  );
}

type InlinePart = string | ReactElement;

function renderInlineTokens(tokens: Token[], keyPrefix: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let index = 0;
  for (const token of tokens) {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "escape":
      case "text":
      case "em_text": {
        const textToken = token as Tokens.Text | Tokens.Escape;
        if ("tokens" in textToken && textToken.tokens?.length) {
          parts.push(...renderInlineTokens(textToken.tokens, key));
        } else {
          appendPart(parts, textToken.text);
        }
        break;
      }
      case "strong":
        parts.push(
          <strong key={key}>{renderInlineTokens((token as Tokens.Strong).tokens ?? [], key)}</strong>,
        );
        break;
      case "em":
        parts.push(<em key={key}>{renderInlineTokens((token as Tokens.Em).tokens ?? [], key)}</em>);
        break;
      case "del":
        parts.push(<del key={key}>{renderInlineTokens((token as Tokens.Del).tokens ?? [], key)}</del>);
        break;
      case "codespan":
        parts.push(
          <code key={key} className="inline-code">
            {(token as Tokens.Codespan).text}
          </code>,
        );
        break;
      case "inlineMath":
        parts.push(
          <code key={key} className="inline-code markdown-math-inline">
            {latexToUnicode((token as unknown as MathToken).text).replace(/\s*\n\s*/g, " ")}
          </code>,
        );
        break;
      case "br":
        parts.push("\n");
        break;
      case "link": {
        const link = token as Tokens.Link;
        const label = link.tokens?.length ? renderInlineTokens(link.tokens, key) : [link.text];
        const href = safeLinkHref(link.href);
        if (href) {
          const external = isExternalWebHref(href);
          parts.push(
            <a
              key={key}
              className="markdown-link"
              href={href}
              title={link.title ?? undefined}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
              data-gesture-exclusion
            >
              {label}
            </a>,
          );
        } else {
          for (const part of label) {
            if (typeof part === "string") appendPart(parts, part);
            else parts.push(part);
          }
        }
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = safeLinkHref(image.href);
        if (href) {
          const external = isExternalWebHref(href);
          parts.push(
            <a
              key={key}
              className="markdown-link markdown-image-link"
              href={href}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
              data-gesture-exclusion
            >
              {image.text || image.href}
            </a>,
          );
        } else {
          appendPart(parts, image.text);
        }
        break;
      }
      case "html":
        appendPart(parts, (token as Tokens.HTML).raw.trim());
        break;
      default:
        if ("text" in token && typeof (token as { text?: unknown }).text === "string") {
          appendPart(parts, (token as unknown as { text: string }).text);
        }
    }
    index += 1;
  }
  return parts;
}

function appendPart(parts: InlinePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (typeof previous === "string") parts[parts.length - 1] = previous + value;
  else parts.push(value);
}

function renderList(list: Tokens.List, key: string): ReactElement {
  const items = list.items.map((item, itemIndex) => {
    const itemKey = `${key}-${itemIndex}`;
    const content = (item.tokens ?? []).map((child, childIndex) => {
      const childKey = `${itemKey}-${childIndex}`;
      if (child.type === "checkbox") return null;
      if (child.type === "list") return renderList(child as Tokens.List, childKey);
      if (child.type === "text") return renderInlineTokens(child.tokens ?? [child], childKey);
      return renderBlockToken(child, childKey);
    });
    return (
      <li key={itemKey} className={item.task ? "markdown-task-item" : undefined}>
        {item.task && (
          <input
            type="checkbox"
            checked={Boolean(item.checked)}
            readOnly
            disabled
            aria-label={item.checked ? "Completed task" : "Incomplete task"}
          />
        )}
        {content}
      </li>
    );
  });
  if (!list.ordered) {
    return (
      <ul key={key} className="markdown-list markdown-list-unordered">
        {items}
      </ul>
    );
  }
  const start = typeof list.start === "number" ? list.start : 1;
  return (
    <ol key={key} className="markdown-list markdown-list-ordered" start={start === 1 ? undefined : start}>
      {items}
    </ol>
  );
}

function renderTableCell(cell: Tokens.TableCell, key: string): InlinePart[] {
  return renderInlineTokens(cell.tokens ?? [], key);
}

function alignmentStyle(align: "center" | "left" | "right" | null): React.CSSProperties | undefined {
  if (!align) return undefined;
  return { textAlign: align };
}

function renderTable(table: Tokens.Table, key: string): ReactElement {
  return (
    <table key={key} className="markdown-table" tabIndex={0}>
      <thead>
        <tr>
          {table.header.map((cell, cellIndex) => (
            <th key={`${key}-h-${cellIndex}`} style={alignmentStyle(table.align[cellIndex])}>
              {renderTableCell(cell, `${key}-h-${cellIndex}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, rowIndex) => (
          <tr key={`${key}-r-${rowIndex}`}>
            {row.map((cell, cellIndex) => (
              <td key={`${key}-r-${rowIndex}-${cellIndex}`} style={alignmentStyle(table.align[cellIndex])}>
                {renderTableCell(cell, `${key}-r-${rowIndex}-${cellIndex}`)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderHeading(depth: number, tokens: Token[], key: string): ReactElement {
  const className = `markdown-heading markdown-heading-${depth}`;
  const content = renderInlineTokens(tokens, `${key}-inline`);
  switch (depth) {
    case 1: return <h1 key={key} className={className}>{content}</h1>;
    case 2: return <h2 key={key} className={className}>{content}</h2>;
    case 3: return <h3 key={key} className={className}>{content}</h3>;
    case 4: return <h4 key={key} className={className}>{content}</h4>;
    case 5: return <h5 key={key} className={className}>{content}</h5>;
    default: return <h6 key={key} className={className}>{content}</h6>;
  }
}

function renderBlockquote(quote: Tokens.Blockquote, key: string): ReactElement {
  const chain: Tokens.Blockquote[] = [quote];
  while (true) {
    const children = chain[chain.length - 1].tokens ?? [];
    if (children.length !== 1 || children[0].type !== "blockquote") break;
    chain.push(children[0] as Tokens.Blockquote);
  }

  const innermost = chain[chain.length - 1];
  let content: ReactNode = innermost.tokens?.map((child, childIndex) =>
    renderBlockToken(child, `${key}-${chain.length}-${childIndex}`),
  );
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    content = (
      <blockquote key={index === 0 ? key : `${key}-quote-${index}`} className="markdown-blockquote">
        {content}
      </blockquote>
    );
  }
  return content as ReactElement;
}

function renderMathBlock(token: MathToken, key: string): ReactElement {
  const converted = latexToUnicode(token.text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return (
    <pre key={key} className="markdown-math-block" data-gesture-exclusion>
      <code>{converted}</code>
    </pre>
  );
}

function isUnterminatedFencedCode(raw: string): boolean {
  const lines = raw.split("\n");
  const opener = FENCE_OPENER.exec(lines[0] ?? "");
  if (!opener || (opener[2][0] === "`" && opener[3].includes("`"))) return false;
  const closer = closeFencePattern(opener[2][0], opener[2].length);
  return !lines.slice(1).some((line) => closer.test(line));
}

function renderBlockToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return renderHeading(heading.depth, heading.tokens ?? [], key);
    }
    case "paragraph":
      return (
        <p key={key} className="markdown-paragraph">
          {renderInlineTokens((token as Tokens.Paragraph).tokens ?? [], `${key}-inline`)}
        </p>
      );
    case "code":
      return (
        <MemoizedCodeBlock
          key={key}
          lang={(token as Tokens.Code).lang ?? ""}
          code={(token as Tokens.Code).text}
          streaming={isUnterminatedFencedCode(token.raw)}
        />
      );
    case "blockMath":
      return renderMathBlock(token as unknown as MathToken, key);
    case "table":
      return renderTable(token as Tokens.Table, key);
    case "list":
      return renderList(token as Tokens.List, key);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, key);
    case "hr":
      return <hr key={key} className="markdown-hr" />;
    case "space":
      return null;
    case "html":
      return (
        <p key={key} className="markdown-paragraph">
          {(token as Tokens.HTML).raw.trim()}
        </p>
      );
    case "text":
      return (
        <p key={key} className="markdown-paragraph">
          {renderInlineTokens((token as Tokens.Text).tokens ?? [token], `${key}-inline`)}
        </p>
      );
    default:
      if ("text" in token && typeof (token as { text?: unknown }).text === "string") {
        return (
          <p key={key} className="markdown-paragraph">
            {(token as unknown as { text: string }).text}
          </p>
        );
      }
      return null;
  }
}

interface MarkdownBlockProps {
  token: Token;
  fingerprint: string;
  start: number;
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({ token, start }: MarkdownBlockProps) {
    return <>{renderBlockToken(token, `md-${start}`)}</>;
  },
  (previous, next) => previous.start === next.start && previous.fingerprint === next.fingerprint,
);

function renderProse(text: string, segmentStart: number): ReactNode {
  if (text.length > MARKDOWN_PARSE_MAX_CHARS) return <p className="markdown-paragraph">{text}</p>;
  const tokens = pickMarkdownParser(text).lexer(text);
  const linksFingerprint = Object.keys(tokens.links).length > 0 ? JSON.stringify(tokens.links) : "";
  let tokenStart = segmentStart;
  return (
    <>
      {tokens.map((token) => {
        const start = tokenStart;
        tokenStart += token.raw.length;
        const fingerprint = `${token.type}\0${token.raw}\0${linksFingerprint}`;
        return <MemoizedMarkdownBlock key={start} token={token} fingerprint={fingerprint} start={start} />;
      })}
    </>
  );
}

export const MemoizedCodeBlock = memo(function CodeBlockView({
  lang,
  code,
  streaming,
}: {
  lang: string;
  code: string;
  streaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail; the text remains selectable.
    }
  }
  return (
    <figure className="code-block" data-gesture-exclusion>
      <figcaption className="code-block-bar">
        <span>{lang || "code"}</span>
        {streaming ? (
          <span className="code-streaming">writing…</span>
        ) : (
          <button onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy code"} disabled={copied}>
            {copied ? <Check /> : <Copy />}
          </button>
        )}
      </figcaption>
      <pre><SyntaxHighlight lang={lang} code={code} /></pre>
    </figure>
  );
});

export function renderInline(text: string): Array<string | ReactElement> {
  const parser = pickMarkdownParser(text);
  const tokens = parser.Lexer.lexInline(text, parser.defaults);
  return renderInlineTokens(tokens, "inline");
}

export function MessageContent({ text }: { text: string }) {
  const content = useMemo(() => renderProse(text, 0), [text]);
  if (!text) return null;
  return <>{content}</>;
}
