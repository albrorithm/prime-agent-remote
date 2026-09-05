import { CircleAlert, HelpCircle, ShieldAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AttentionRequest } from "../../protocol";
import { MAX_ATTENTION_TEXT_CHARS } from "../../protocol";
import { useGateway } from "../gateway-store";

/**
 * What has been typed into a text request that has not been sent. Keyed by
 * request id and kept outside React so switching agents, opening a drawer, or
 * the card remounting for any other reason does not lose an answer halfway
 * through. Cleared when the answer goes, or the request does.
 */
const textDrafts = new Map<string, string>();

/** For a test: forget every unsent answer. */
export function clearAttentionDrafts(): void {
  textDrafts.clear();
}

function remainingSeconds(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Seconds left on the request's deadline, ticking once a second; null when it has none. */
function useCountdown(expiresAt: string | undefined): number | null {
  const [remaining, setRemaining] = useState(() => remainingSeconds(expiresAt, Date.now()));
  useEffect(() => {
    setRemaining(remainingSeconds(expiresAt, Date.now()));
    if (!expiresAt) return;
    const timer = setInterval(() => {
      const next = remainingSeconds(expiresAt, Date.now());
      setRemaining(next);
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return remaining;
}

export function AttentionCard({ request }: { request: AttentionRequest }) {
  const { respond } = useGateway();
  const [responding, setResponding] = useState(false);
  const remaining = useCountdown(request.expiresAt);
  const expired = remaining === 0;
  const Icon = request.kind === "dialog" ? ShieldAlert : request.kind === "question" ? HelpCircle : CircleAlert;
  const textReply = request.reply.kind === "text" ? request.reply : null;

  async function answer(reply: { optionId: string } | { text: string }) {
    if (responding || expired) return;
    setResponding(true);
    try {
      await respond(request.id, request.revision, reply);
      textDrafts.delete(request.id);
    } catch {
      // The gateway store explains the failure in its banner. A request the
      // gateway no longer holds is removed by the store, so this card goes
      // with it; anything else keeps the card, and the draft, for another go.
    } finally {
      setResponding(false);
    }
  }

  return (
    <section
      className={`attention-card ${textReply ? "attention-card-text" : ""} ${expired ? "attention-card-expired" : ""}`}
      aria-labelledby={`attention-${request.id}`}
    >
      <div className="attention-heading">
        <Icon aria-hidden="true" />
        <div>
          <p className="eyebrow">
            {request.kind === "dialog" ? "Extension dialog" : textReply ? "Extension question" : "Needs attention"}
          </p>
          <h3 id={`attention-${request.id}`}>{request.title}</h3>
        </div>
        {remaining !== null && (
          <span className={`attention-expiry ${remaining <= 60 ? "urgent" : ""}`} role="timer" aria-live="off">
            {expired ? "Expired" : clock(remaining)}
          </span>
        )}
      </div>
      {request.detail && <p>{request.detail}</p>}
      {textReply && (
        <TextReplyField
          requestId={request.id}
          multiline={textReply.multiline}
          placeholder={textReply.placeholder}
          prefill={textReply.prefill}
          disabled={responding || expired}
          onSubmit={(text) => void answer({ text })}
        />
      )}
      {expired && (
        <p className="attention-terminal" role="status">
          This request expired before it was answered. The extension went on without an answer.
        </p>
      )}
      <div className="attention-actions">
        {request.options.map((option) => (
          <button
            key={option.id}
            className={`attention-action ${option.tone}`}
            onClick={() => void answer({ optionId: option.id })}
            disabled={responding || expired}
          >
            {option.label}
          </button>
        ))}
        {textReply && (
          <button
            type="submit"
            form={`attention-form-${request.id}`}
            className="attention-action safe"
            disabled={responding || expired}
          >
            {responding ? "Sending…" : "Submit"}
          </button>
        )}
      </div>
    </section>
  );
}

interface TextReplyFieldProps {
  requestId: string;
  multiline: boolean;
  placeholder?: string;
  prefill?: string;
  disabled: boolean;
  onSubmit: (text: string) => void;
}

/**
 * The field a text request is answered in: one line for `input`, a growing
 * box for `editor`. Enter sends a line; a document sends on Cmd/Ctrl+Enter so
 * Enter can stay a newline, which is what an editor asked for.
 */
function TextReplyField({ requestId, multiline, placeholder, prefill, disabled, onSubmit }: TextReplyFieldProps) {
  const [value, setValue] = useState(() => textDrafts.get(requestId) ?? prefill ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function change(next: string) {
    setValue(next);
    textDrafts.set(requestId, next);
  }

  // Grows with its content up to a bound, like the composer, so a prefilled
  // document is readable without opening it and a long answer does not push
  // the transcript off the screen.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(280, Math.max(88, textarea.scrollHeight))}px`;
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== "Enter") return;
    const sends = multiline ? event.metaKey || event.ctrlKey : !event.shiftKey;
    if (!sends) return;
    event.preventDefault();
    if (!disabled) onSubmit(value);
  }

  const id = `attention-field-${requestId}`;
  return (
    <form
      id={`attention-form-${requestId}`}
      className="attention-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit(value);
      }}
    >
      <label htmlFor={id} className="sr-only">Your answer</label>
      {multiline ? (
        <textarea
          ref={textareaRef}
          id={id}
          className="attention-field"
          value={value}
          placeholder={placeholder}
          maxLength={MAX_ATTENTION_TEXT_CHARS}
          disabled={disabled}
          rows={4}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <input
          id={id}
          className="attention-field"
          type="text"
          value={value}
          placeholder={placeholder}
          maxLength={MAX_ATTENTION_TEXT_CHARS}
          disabled={disabled}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      {multiline && <p className="attention-hint">Enter for a new line. Cmd or Ctrl and Enter to submit.</p>}
    </form>
  );
}
