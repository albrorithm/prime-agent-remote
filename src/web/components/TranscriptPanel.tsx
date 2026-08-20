import { ArrowDown, Bot, GitBranch, LoaderCircle, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useGateway } from "../gateway-store";
import { AttentionCard } from "./AttentionCard";
import { Composer } from "./Composer";

export function TranscriptPanel() {
  const { selectedAgent, selectedSnapshot, selectAgent } = useGateway();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const messageCount = selectedSnapshot?.messages.length ?? 0;
  const lastText = selectedSnapshot?.messages.at(-1)?.text ?? "";

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (following) {
      element.scrollTop = element.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((count) => count + 1);
    }
  }, [messageCount, lastText, following]);

  function updateFollowing() {
    const element = scrollRef.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
  }

  if (!selectedAgent) {
    return <section className="panel transcript-panel empty-state">Select an agent to open its transcript.</section>;
  }

  return (
    <section className="panel transcript-panel" aria-labelledby="transcript-heading">
      <header className="panel-header transcript-header">
        <div className="agent-avatar"><Bot aria-hidden="true" /></div>
        <div className="transcript-title">
          <p className="eyebrow">{selectedAgent.parentId ? "Subagent" : "Root agent"}</p>
          <h2 id="transcript-heading">{selectedAgent.name}</h2>
        </div>
        <span className={`state-pill ${selectedAgent.attention ? "attention" : ""}`}>
          {selectedAgent.attention ? `Needs ${selectedAgent.attention}` : selectedAgent.activity}
        </span>
      </header>

      <div
        className="transcript-scroll"
        ref={scrollRef}
        onScroll={updateFollowing}
        aria-label={`${selectedAgent.name} transcript`}
      >
        {selectedSnapshot?.attention.map((request) => <AttentionCard key={request.id} request={request} />)}
        {!selectedSnapshot ? (
          <div className="loading-state"><LoaderCircle className="spin" /> Loading transcript…</div>
        ) : (
          <div className="message-list" role="log" aria-live="off">
            {selectedSnapshot.messages.map((message) => (
              <article key={message.id} className={`message ${message.role} ${message.state}`}>
                <div className="message-author">
                  {message.role === "user" ? <User aria-hidden="true" /> : <Bot aria-hidden="true" />}
                  <span>{message.role === "user" ? "You" : selectedAgent.name}</span>
                  <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </div>
                <p>{message.text || (message.state === "streaming" ? "Thinking…" : "")}</p>
                {message.state === "streaming" && <span className="streaming-indicator" aria-label="Streaming" />}
              </article>
            ))}
            {selectedSnapshot.activity.some((item) => item.kind === "child" && item.agentId) && (
              <div className="inline-children">
                {selectedSnapshot.activity.filter((item) => item.kind === "child" && item.agentId).map((item) => (
                  <button key={item.id} onClick={() => void selectAgent(item.agentId!)}>
                    <GitBranch /> <span><strong>{item.title}</strong><small>{item.status}</small></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {!following && unseen > 0 && (
        <button
          className="jump-latest"
          onClick={() => {
            setFollowing(true);
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          }}
        ><ArrowDown /> Jump to latest ({unseen})</button>
      )}
      <Composer />
    </section>
  );
}
