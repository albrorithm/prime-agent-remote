/** How much of a whole message the "no selection" fallback will quote before it has to point at the message instead of pasting it. */
export const WHOLE_MESSAGE_QUOTE_LIMIT = 1000;

export interface BuildQuotationInput {
  /** The full message body, used when there is no in-message selection. */
  text: string;
  /** Who said it — becomes the `> From <source>:` line. */
  source: string;
  /** A user text selection scoped to this message, if any. Takes priority over `text`. */
  selection?: string;
  /** The most this quotation block (header, body, and its trailing blank line) may run to. */
  maxChars: number;
}

export interface BuiltQuotation {
  /** The rendered `> `-quoted block, or "" if nothing fit inside `maxChars`. */
  quotation: string;
  /** True if the body had to be cut short — by the whole-message cap, by `maxChars`, or both. */
  trimmed: boolean;
}

function truncateWithEllipsis(value: string, limit: number): { value: string; trimmed: boolean } {
  if (value.length <= limit) return { value, trimmed: false };
  if (limit <= 0) return { value: "", trimmed: true };
  return { value: `${value.slice(0, limit - 1).trimEnd()}…`, trimmed: true };
}

function render(source: string, body: string): string {
  const quotedLines = body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `> From ${source}:\n${quotedLines}\n\n`;
}

/**
 * Builds a `> `-quoted block: a one-line attribution, the quoted body, and a
 * trailing blank line a reply can be typed straight after. Pure and
 * draft-agnostic on purpose — joining it onto an existing draft, and staying
 * under that draft's own length limit, is a separate concern handled by
 * `quotationRoom` and `appendQuotation` below.
 */
export function buildQuotation({ text, source, selection, maxChars }: BuildQuotationInput): BuiltQuotation {
  const usingSelection = Boolean(selection && selection.trim());
  let body = usingSelection ? selection!.trim() : text;
  let trimmed = false;
  if (!usingSelection) {
    // A selection is something the user deliberately chose the bounds of;
    // only the "quote the whole thing" fallback needs a cap of its own.
    const bounded = truncateWithEllipsis(body, WHOLE_MESSAGE_QUOTE_LIMIT);
    body = bounded.value;
    trimmed = bounded.trimmed;
  }

  let quotation = render(source, body);
  if (quotation.length > maxChars) {
    trimmed = true;
    const overhead = quotation.length - body.length;
    const room = Math.max(0, maxChars - overhead);
    body = truncateWithEllipsis(body, room).value;
    quotation = render(source, body);
    // maxChars can be small enough that even the header and trailing blank
    // line alone overflow it (an almost-full draft). Clip the rendered block
    // as a last resort rather than hand back something over budget.
    if (quotation.length > maxChars) quotation = quotation.slice(0, Math.max(0, maxChars));
  }
  return { quotation, trimmed };
}

/** How many characters a quotation block may use without pushing `draft` (plus a blank-line separator, if any) over `maxTotal`. */
export function quotationRoom(draft: string, maxTotal: number): number {
  const trimmedDraft = draft.replace(/\s+$/, "");
  const separator = trimmedDraft ? 2 : 0; // "\n\n"
  return Math.max(0, maxTotal - trimmedDraft.length - separator);
}

/** Appends a built quotation onto a draft, adding exactly one blank line of separation when the draft already has content. */
export function appendQuotation(draft: string, quotation: string): string {
  if (!quotation) return draft;
  const trimmedDraft = draft.replace(/\s+$/, "");
  return trimmedDraft ? `${trimmedDraft}\n\n${quotation}` : quotation;
}

/**
 * A quotation waiting in a session's composer, shown there as a chip above the
 * field and sent ahead of whatever is typed. Held per session, outside React,
 * so a quote taken from one message survives the composer remounting and can
 * be aimed at another session (a parent) from a child's transcript. Not
 * persisted: a quote is a gesture about the reply being written now, and one
 * that reappeared after a reload would be a surprise.
 */
export interface PendingQuote {
  /** Who said it: the message author as the transcript names them. */
  source: string;
  text: string;
}

const pendingQuotes = new Map<string, PendingQuote>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, PendingQuote> = new Map();

function notify(): void {
  snapshot = new Map(pendingQuotes);
  for (const listener of listeners) listener();
}

export function setPendingQuote(agentId: string, quote: PendingQuote | null): void {
  if (quote) pendingQuotes.set(agentId, { source: quote.source, text: quote.text.trim() });
  else pendingQuotes.delete(agentId);
  notify();
}

export function subscribePendingQuotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function pendingQuotesSnapshot(): ReadonlyMap<string, PendingQuote> {
  return snapshot;
}

/** For a test: forget every waiting quotation. */
export function clearPendingQuotes(): void {
  pendingQuotes.clear();
  notify();
}

/** How a quotation goes on the wire: a Markdown blockquote naming its source, then the reply. */
export function composeWithQuote(quote: PendingQuote | undefined, text: string): string {
  if (!quote) return text;
  const { quotation } = buildQuotation({ text: quote.text, source: quote.source, selection: quote.text, maxChars: Number.POSITIVE_INFINITY });
  return `${quotation}${text}`;
}
