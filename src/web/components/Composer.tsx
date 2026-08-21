import { Command, Image, Plus, Send, Square, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useGateway } from "../gateway-store";

const DRAFTS_KEY = "prime-web-drafts";

function loadDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function Composer() {
  const { selectedAgent, selectedSnapshot, send, abort } = useGateway();
  const [drafts, setDraftsState] = useState<Record<string, string>>(loadDrafts);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const id = selectedAgent?.id ?? "";
  const draft = drafts[id] ?? "";
  const streaming = selectedSnapshot?.messages.some((message) => message.state === "streaming") ?? false;

  function setDrafts(update: (current: Record<string, string>) => Record<string, string>) {
    setDraftsState((current) => {
      const next = update(current);
      try {
        sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable; drafts still work in memory.
      }
      return next;
    });
  }

  useEffect(() => {
    setSending(false);
    setStopping(false);
    setOptionsOpen(false);
  }, [id]);

  useEffect(() => {
    if (!optionsOpen) return;
    const close = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [optionsOpen]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(152, Math.max(44, textarea.scrollHeight))}px`;
  }, [draft]);

  async function submit() {
    if (!id || !draft.trim() || sending) return;
    setSending(true);
    setOptionsOpen(false);
    try {
      await send(draft.trim());
      setDrafts((current) => ({ ...current, [id]: "" }));
    } catch {
      // The gateway store exposes the error. Keep the draft for retry.
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await abort();
    } catch {
      // The gateway store exposes the error.
    } finally {
      setStopping(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && optionsOpen) {
      event.preventDefault();
      setOptionsOpen(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function startSlashCommand() {
    setDrafts((current) => ({ ...current, [id]: current[id]?.trim() ? current[id] : "/" }));
    setOptionsOpen(false);
    queueMicrotask(() => textareaRef.current?.focus());
  }

  if (!selectedAgent) return null;
  return (
    <div className="composer" ref={composerRef} data-gesture-exclusion>
      {optionsOpen && (
        <div className="composer-menu" id="composer-options" role="menu" aria-label="Composer options">
          <button role="menuitem" onClick={startSlashCommand}><Command /><span><strong>Slash command</strong><small>Run a Prime command</small></span></button>
          <button role="menuitem" disabled><Image /><span><strong>Image</strong><small>Not exposed by this gateway yet</small></span></button>
          <button role="menuitem" disabled><Wrench /><span><strong>Tools and plugins</strong><small>Capability projection required</small></span></button>
        </div>
      )}
      <button
        className="composer-options-trigger"
        aria-label="Composer options"
        aria-expanded={optionsOpen}
        aria-controls="composer-options"
        onClick={() => setOptionsOpen((open) => !open)}
      ><Plus /></button>
      <label htmlFor="message-composer" className="sr-only">Message {selectedAgent.name}</label>
      <textarea
        ref={textareaRef}
        id="message-composer"
        value={draft}
        onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={selectedAgent.capabilities.send ? `Message ${selectedAgent.name}` : "Resume this agent before sending"}
        disabled={!selectedAgent.capabilities.send}
      />
      {streaming && selectedAgent.capabilities.abort ? (
        <button className="composer-action stop" onClick={() => void stop()} disabled={stopping} aria-label="Stop agent"><Square /></button>
      ) : (
        <button
          className="composer-action send"
          onClick={() => void submit()}
          disabled={!selectedAgent.capabilities.send || !draft.trim() || sending}
          aria-label="Send message"
        ><Send /></button>
      )}
    </div>
  );
}
