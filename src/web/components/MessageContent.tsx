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

export function renderInline(text: string): Array<string | ReactElement> {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((part, index) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="inline-code">{part.slice(1, -1)}</code>;
    }
    return part;
  });
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
          <p key={index}>{renderInline(block.text)}</p>
        ),
      )}
    </>
  );
}
