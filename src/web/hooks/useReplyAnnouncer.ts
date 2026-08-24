import { useEffect, useRef, useState } from "react";
import type { TranscriptMessage } from "../../protocol";

interface AnnouncerSnapshot {
  agentId: string;
  messages: TranscriptMessage[];
}

export function useReplyAnnouncer(
  agentId: string | null,
  agentName: string | undefined,
  selectedSnapshot: AnnouncerSnapshot | null | undefined,
) {
  const [replyAnnouncement, setReplyAnnouncement] = useState({ key: 0, text: "" });
  const announcementAgentIdRef = useRef<string | null>(null);
  const announcementInitializedRef = useRef(false);
  const announcedMessageStatesRef = useRef(new Map<string, TranscriptMessage["state"]>());

  useEffect(() => {
    if (announcementAgentIdRef.current !== agentId) {
      announcementAgentIdRef.current = agentId;
      announcementInitializedRef.current = false;
      announcedMessageStatesRef.current.clear();
      setReplyAnnouncement((current) => current.text ? { key: current.key + 1, text: "" } : current);
    }
    if (!agentId || selectedSnapshot?.agentId !== agentId) return;

    const nextStates = new Map<string, TranscriptMessage["state"]>();
    for (const message of selectedSnapshot.messages) nextStates.set(message.id, message.state);
    if (!announcementInitializedRef.current) {
      announcedMessageStatesRef.current = nextStates;
      announcementInitializedRef.current = true;
      return;
    }

    let text = "";
    const name = agentName ?? "Agent";
    for (const message of selectedSnapshot.messages) {
      if (message.role !== "assistant" || message.presentation) continue;
      const previousState = announcedMessageStatesRef.current.get(message.id);
      if (message.state === "complete" && previousState && previousState !== "complete") {
        text = `${name} finished replying.`;
      } else if (message.state === "complete" && !previousState) {
        text = `${name} replied.`;
      } else if (message.state === "failed" && previousState !== "failed") {
        text = `${name}'s reply failed.`;
      }
    }
    announcedMessageStatesRef.current = nextStates;
    if (text) setReplyAnnouncement((current) => ({ key: current.key + 1, text }));
  }, [agentId, agentName, selectedSnapshot]);

  return replyAnnouncement;
}
