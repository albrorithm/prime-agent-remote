import { GitBranch, Quote as QuoteIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useGateway } from "../gateway-store";
import { setPendingQuote } from "../quote";

interface Anchor {
  text: string;
  /** Who wrote the message the selection sits in, as the transcript names them. */
  source: string;
  top: number;
  left: number;
}

/** The longest run a floating pill will take from one selection. */
const MAX_SELECTION_QUOTE_CHARS = 4_000;

/**
 * Where a selection inside a transcript message is, and whose message it is.
 * Null for a selection anywhere else on the page, or none at all.
 */
function readSelection(agentName: string): Anchor | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const article = element?.closest("article.message");
  if (!article || article.classList.contains("pending")) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    // A whole-message quote says when it was cut; a selection should too.
    text: text.length > MAX_SELECTION_QUOTE_CHARS ? `${text.slice(0, MAX_SELECTION_QUOTE_CHARS - 1).trimEnd()}…` : text,
    source: article.classList.contains("user") ? "You" : agentName,
    top: rect.top,
    left: rect.left + rect.width / 2,
  };
}

/**
 * A pill that follows a text selection inside the transcript and offers to
 * quote it: into this session's reply, or, from a subagent, into its parent's.
 * It sits beside the selection the way the reply bubbles in the chat apps
 * people already use do, and leaves the native selection menu alone.
 */
export function SelectionQuote() {
  const { selectedAgent, catalog } = useGateway();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const agentName = selectedAgent?.name ?? "";
  const parent = selectedAgent?.parentId ? catalog.agents.find((agent) => agent.id === selectedAgent.parentId) ?? null : null;

  useEffect(() => {
    if (!selectedAgent) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      // After the browser has finished moving the selection, not during.
      frame = requestAnimationFrame(() => setAnchor(readSelection(agentName)));
    };
    const hide = () => setAnchor(null);
    document.addEventListener("selectionchange", update);
    // A scroll moves the selection under the pill; the next selectionchange redraws it.
    document.addEventListener("scroll", hide, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("scroll", hide, true);
    };
  }, [selectedAgent, agentName]);

  if (!anchor || !selectedAgent) return null;

  function quote(targetId: string) {
    if (!anchor) return;
    setPendingQuote(targetId, { source: anchor.source, text: anchor.text });
    document.getSelection()?.removeAllRanges();
    setAnchor(null);
  }

  // Above the selection, clamped to the viewport; below it when there is no room above.
  const above = anchor.top > 64;
  const style = {
    top: above ? anchor.top - 8 : anchor.top + 28,
    left: Math.min(Math.max(anchor.left, 96), window.innerWidth - 96),
    transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
  };
  return (
    <div className="selection-quote" role="toolbar" aria-label="Quote the selection" style={style} data-gesture-exclusion>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => quote(selectedAgent.id)}>
        <QuoteIcon aria-hidden="true" /> Quote
      </button>
      {parent && (
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => quote(parent.id)} aria-label={`Quote into ${parent.name}'s message`}>
          <GitBranch aria-hidden="true" /> To parent
        </button>
      )}
    </div>
  );
}
