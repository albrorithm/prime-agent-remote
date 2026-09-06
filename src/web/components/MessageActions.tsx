import { Check, Copy, GitBranch, Quote as QuoteIcon, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useGateway } from "../gateway-store";
import { MAX_DRAFT_LENGTH, useComposerDrafts } from "../hooks/useComposerDrafts";
import { appendQuotation, buildQuotation, quotationRoom } from "../quote";
import { SwitchHapticButton } from "./SwitchHapticButton";

/** Web Share is present in iOS standalone PWAs but absent in jsdom and older desktops. */
export function shareSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * A selection the user made inside this message specifically — not whatever
 * happens to be selected on the page. `article` is this row's own enclosing
 * `<article className="message …">`, so a selection anchored anywhere else
 * (another message, the composer, the header) is treated as no selection at
 * all rather than quoting the wrong text.
 */
function selectionWithin(article: Element | null): string | undefined {
  if (!article || typeof window === "undefined") return undefined;
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  if (!selection.anchorNode || !article.contains(selection.anchorNode)) return undefined;
  const text = selection.toString();
  return text.trim() ? text : undefined;
}

type Confirmation = { kind: "copy" | "quote-self" | "quote-parent"; message: string };

/**
 * The per-message action row, rendered under the message body.
 *
 * Deliberately NOT a long press. iOS long press already belongs to native text
 * selection (Select / Copy / Look Up / Translate), and in a standalone PWA that
 * callout is the only way to copy part of a message, so overriding it is a net
 * loss. A JS long press also cannot fire this app's switch-based haptic, which
 * needs a real toggle from the user's own touch, so it would open silently.
 * A visible row costs nothing, works with VoiceOver and a keyboard, and is
 * where people look for these controls anyway. Quoting reads the same native
 * selection for the same reason — it never installs its own.
 */
export function MessageActions({ text, label }: { text: string; label: string }) {
  const { selectedAgent, catalog } = useGateway();
  const rootRef = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);

  const selfId = selectedAgent?.id ?? "";
  const parent = selectedAgent?.parentId
    ? catalog.agents.find((agent) => agent.id === selectedAgent.parentId) ?? null
    : null;
  // Called unconditionally (hook rules) even with no parent — an empty id
  // just never gets written to, since `quote("parent")` bails out first.
  const selfDrafts = useComposerDrafts(selfId);
  const parentDrafts = useComposerDrafts(parent?.id ?? "");

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  function confirm(next: Confirmation) {
    setConfirmation(next);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setConfirmation(null), 1600);
  }

  function copy() {
    // Safari only honours a clipboard write inside the gesture that requested
    // it, so the write starts here with nothing awaited in front of it.
    const written = navigator.clipboard?.writeText(text);
    if (!written) return;
    void written.then(
      () => confirm({ kind: "copy", message: "Copied" }),
      () => {
        // Clipboard access can be denied; the text stays selectable.
      },
    );
  }

  function share() {
    void navigator.share?.({ text }).catch(() => {
      // The user dismissed the sheet, or sharing is unavailable.
    });
  }

  function quote(target: "self" | "parent") {
    const destination = target === "self"
      ? (selfId ? { id: selfId, drafts: selfDrafts } : null)
      : (parent ? { id: parent.id, drafts: parentDrafts } : null);
    if (!destination) return;

    const article = rootRef.current?.closest("article") ?? null;
    const selection = selectionWithin(article);
    const currentDraft = destination.drafts.draft;
    const { quotation, trimmed } = buildQuotation({
      text,
      source: label,
      selection,
      maxChars: quotationRoom(currentDraft, MAX_DRAFT_LENGTH),
    });
    const nextDraft = appendQuotation(currentDraft, quotation).slice(0, MAX_DRAFT_LENGTH);
    destination.drafts.setDrafts((current) => ({ ...current, [destination.id]: nextDraft }));

    confirm(target === "self"
      ? { kind: "quote-self", message: trimmed ? "Quoted, trimmed" : "Quoted" }
      : { kind: "quote-parent", message: trimmed ? `Quoted for ${parent!.name}, trimmed` : `Quoted for ${parent!.name}` });
  }

  if (!text) return null;

  return (
    <div ref={rootRef} className="message-actions" role="group" aria-label={`${label} message actions`} data-gesture-exclusion>
      <SwitchHapticButton
        buttonClassName="message-action"
        label={confirmation?.kind === "copy" ? "Copied" : "Copy message"}
        onActivate={copy}
      >
        {confirmation?.kind === "copy" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </SwitchHapticButton>
      {shareSupported() && (
        <SwitchHapticButton buttonClassName="message-action" label="Share message" onActivate={share}>
          <Share2 aria-hidden="true" />
        </SwitchHapticButton>
      )}
      {selfId && (
        <SwitchHapticButton
          buttonClassName="message-action"
          label={confirmation?.kind === "quote-self" ? confirmation.message : "Quote into this session's message"}
          onActivate={() => quote("self")}
        >
          {confirmation?.kind === "quote-self" ? <Check aria-hidden="true" /> : <QuoteIcon aria-hidden="true" />}
        </SwitchHapticButton>
      )}
      {parent && (
        <SwitchHapticButton
          buttonClassName="message-action"
          label={confirmation?.kind === "quote-parent" ? confirmation.message : `Quote into ${parent.name}'s message`}
          onActivate={() => quote("parent")}
        >
          {confirmation?.kind === "quote-parent" ? <Check aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
        </SwitchHapticButton>
      )}
      <span className="sr-only" role="status" aria-live="polite">{confirmation?.message ?? ""}</span>
    </div>
  );
}
