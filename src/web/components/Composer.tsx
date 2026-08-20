import { Send, Square } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useGateway } from "../gateway-store";

export function Composer() {
  const { selectedAgent, selectedSnapshot, send, abort } = useGateway();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const id = selectedAgent?.id ?? "";
  const draft = drafts[id] ?? "";
  const streaming = selectedSnapshot?.messages.some((message) => message.state === "streaming") ?? false;

  useEffect(() => {
    setSending(false);
    setStopping(false);
  }, [id]);

  async function submit() {
    if (!id || !draft.trim() || sending) return;
    setSending(true);
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
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  if (!selectedAgent) return null;
  return (
    <div className="composer">
      <label htmlFor="message-composer" className="sr-only">Message {selectedAgent.name}</label>
      <textarea
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
