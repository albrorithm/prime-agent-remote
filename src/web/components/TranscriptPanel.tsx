import { ArrowDown, Bot, Brain, Check, ChevronRight, Circle, CircleAlert, ListTree, LoaderCircle, Menu, Search, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AgentSummary, TranscriptMessage } from "../../protocol";
import { useGateway } from "../gateway-store";
import { AttentionCard } from "./AttentionCard";
import { Composer } from "./Composer";
import { GoalStrip } from "./GoalStrip";
import { MessageContent } from "./MessageContent";

interface TranscriptPanelProps {
  onOpenSessions: () => void;
  onOpenActivity: () => void;
}

export function deriveAgentLineage(agents: AgentSummary[], selectedId: string | null): AgentSummary[] {
  if (!selectedId) return [];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const lineage: AgentSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | null = selectedId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const agent = byId.get(cursor);
    if (!agent) break;
    lineage.unshift(agent);
    cursor = agent.parentId;
  }
  return lineage;
}

export function countUnseen(previousCount: number, currentCount: number): number {
  return currentCount > previousCount ? currentCount - previousCount : 0;
}

function HighlightedText({ text, term }: { text: string; term: string }) {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return <>{text}</>;
  const parts: Array<string | ReactElement> = [];
  let rest = text;
  let key = 0;
  while (rest.length) {
    const index = rest.toLowerCase().indexOf(normalized);
    if (index < 0) {
      parts.push(rest);
      break;
    }
    if (index > 0) parts.push(rest.slice(0, index));
    parts.push(<mark key={key++}>{rest.slice(index, index + normalized.length)}</mark>);
    rest = rest.slice(index + normalized.length);
  }
  return <>{parts}</>;
}

function ToolStatusIcon({ status }: { status: "running" | "waiting" | "complete" | "failed" | "unknown" }) {
  if (status === "running") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (status === "complete") return <Check aria-hidden="true" />;
  if (status === "failed") return <CircleAlert aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function TranscriptImage({ image, index }: { image: { id: string; src: string }; index: number }) {
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) {
    return <div className="message-image-unavailable" role="img" aria-label={`Attached image ${index + 1} is unavailable`}>Image unavailable</div>;
  }
  return (
    <a href={image.src} target="_blank" rel="noopener noreferrer" aria-label={`View attached image ${index + 1}`}>
      <img src={image.src} alt={`Attached image ${index + 1}`} loading="lazy" decoding="async" onError={() => setUnavailable(true)} />
    </a>
  );
}

function TranscriptImages({ images }: { images: Array<{ id: string; src: string }> }) {
  if (!images.length) return null;
  return (
    <div className={`message-images ${images.length === 1 ? "single" : "multiple"}`} aria-label={`${images.length} attached image${images.length === 1 ? "" : "s"}`} data-gesture-exclusion>
      {images.map((image, index) => <TranscriptImage key={image.id} image={image} index={index} />)}
    </div>
  );
}

export function TranscriptEntry({
  message,
  agentName,
  searchTerm,
}: {
  message: TranscriptMessage;
  agentName: string;
  searchTerm?: string;
}) {
  const presentation = message.presentation;
  if (presentation?.kind === "thinking") {
    return (
      <div className={`timeline-row thinking ${message.state}`} role="note" aria-label={`Thinking: ${message.text}`}>
        <Brain aria-hidden="true" />
        <strong>Thinking…</strong>
        <span className="timeline-separator" aria-hidden="true">·</span>
        <span className="timeline-preview"><HighlightedText text={message.text} term={searchTerm ?? ""} /></span>
      </div>
    );
  }
  if (presentation?.kind === "tool") {
    const meta = presentation.meta ? `, ${presentation.meta}` : "";
    return (
      <div className={`timeline-row tool ${presentation.status}`} role="group" aria-label={`${presentation.label} tool ${presentation.status}: ${message.text}${meta}`}>
        <ToolStatusIcon status={presentation.status} />
        <strong className="timeline-label">{presentation.label}</strong>
        <span className="timeline-separator" aria-hidden="true">·</span>
        <code className="timeline-preview"><HighlightedText text={message.text} term={searchTerm ?? ""} /></code>
        {presentation.meta && (
          <>
            <span className="timeline-separator" aria-hidden="true">·</span>
            <span className="timeline-meta">{presentation.meta}</span>
          </>
        )}
      </div>
    );
  }
  return (
    <article className={`message ${message.role} ${message.state}`}>
      <div className="message-author">
        {message.role === "user" ? <User aria-hidden="true" /> : <Bot aria-hidden="true" />}
        <span>{message.role === "user" ? "You" : agentName}</span>
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      </div>
      <div className="message-body">
        <TranscriptImages
          images={(message.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            src: `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
          }))}
        />
        {searchTerm !== undefined
          ? <p><HighlightedText text={message.text} term={searchTerm} /></p>
          : <MessageContent text={message.text || (message.state === "streaming" ? "Thinking…" : "")} />}
      </div>
      {message.state === "streaming" && <span className="streaming-indicator" aria-label="Streaming" />}
    </article>
  );
}

export function TranscriptPanel({ onOpenSessions, onOpenActivity }: TranscriptPanelProps) {
  const { selectedAgent, selectedSnapshot, pendingMessages, catalog, selectAgent } = useGateway();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const messageCount = selectedSnapshot?.messages.length ?? 0;
  const lastText = selectedSnapshot?.messages.at(-1)?.text ?? "";
  const previousCount = useRef(0);
  const previousAttention = useRef(0);
  const lineage = useMemo(
    () => deriveAgentLineage(catalog.agents, selectedAgent?.id ?? null),
    [catalog.agents, selectedAgent?.id],
  );
  const childCount = selectedAgent ? catalog.agents.filter((agent) => agent.parentId === selectedAgent.id).length : 0;
  const attentionCount = catalog.agents.filter((agent) => agent.attention).length;
  const snapshotAttention = selectedSnapshot?.attention.length ?? 0;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (following) {
      element.scrollTop = element.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((count) => count + countUnseen(previousCount.current, messageCount));
    }
    previousCount.current = messageCount;
  }, [messageCount, following]);

  useEffect(() => {
    if (!following) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastText, following]);

  useEffect(() => {
    if (snapshotAttention > previousAttention.current && typeof navigator.vibrate === "function") {
      navigator.vibrate(30);
    }
    previousAttention.current = snapshotAttention;
  }, [snapshotAttention]);

  function updateFollowing() {
    const element = scrollRef.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
  }

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
  }

  const normalizedQuery = query.trim().toLowerCase();
  const searching = searchOpen && Boolean(normalizedQuery);
  const visibleMessages: TranscriptMessage[] | null = searching && selectedSnapshot
    ? selectedSnapshot.messages.filter((message) => message.text.toLowerCase().includes(normalizedQuery))
    : null;

  return (
    <section className="panel transcript-panel" aria-labelledby="transcript-heading">
      <header className="conversation-header">
        <button className="icon-button sessions-trigger" onClick={onOpenSessions} aria-label={`Open sessions${attentionCount ? `, ${attentionCount} need attention` : ""}`}>
          <Menu />
          {attentionCount > 0 && <span className="icon-badge" aria-hidden="true">{attentionCount > 9 ? "9+" : attentionCount}</span>}
        </button>
        <nav className="agent-lineage" aria-label="Agent ancestry" data-gesture-exclusion>
          {lineage.map((agent, index) => (
            <span className="lineage-item" key={agent.id}>
              {index > 0 && <ChevronRight className="lineage-separator" aria-hidden="true" />}
              {index === lineage.length - 1 ? (
                <h1 id="transcript-heading" title={agent.name}>{agent.name}</h1>
              ) : (
                <button onClick={() => void selectAgent(agent.id)} title={`Open ${agent.name}`}>{agent.name}</button>
              )}
            </span>
          ))}
          {!lineage.length && <h1 id="transcript-heading">Prime Agent</h1>}
        </nav>
        <span
          className={`agent-presence ${selectedAgent?.attention ? "attention" : selectedAgent?.activity ?? "idle"}`}
          aria-label={selectedAgent?.attention ? `Needs ${selectedAgent.attention}` : selectedAgent?.activity ?? "No agent selected"}
        />
        <button
          className={`icon-button search-trigger ${searchOpen ? "active" : ""}`}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          aria-label={searchOpen ? "Close search" : "Search transcript"}
          aria-expanded={searchOpen}
        >
          {searchOpen ? <X /> : <Search />}
        </button>
        <button className="icon-button activity-trigger" onClick={onOpenActivity} aria-label={`Open activity${childCount ? `, ${childCount} subagents` : ""}`}>
          <ListTree />
          {childCount > 0 && <span>{childCount}</span>}
        </button>
      </header>

      {searchOpen && (
        <div className="transcript-search" data-gesture-exclusion>
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this transcript"
            aria-label="Search this transcript"
            autoFocus
          />
          {searching && <span className="search-count">{visibleMessages?.length ?? 0} match{visibleMessages?.length === 1 ? "" : "es"}</span>}
        </div>
      )}

      {!selectedAgent ? (
        <div className="conversation-empty">
          <Bot aria-hidden="true" />
          <h2>Choose a session</h2>
          <p>Open the session drawer to continue a conversation.</p>
          <button onClick={onOpenSessions}>Open sessions</button>
        </div>
      ) : (
        <>
          <div
            className="transcript-scroll"
            ref={scrollRef}
            onScroll={updateFollowing}
            aria-label={`${selectedAgent.name} transcript`}
          >
            <div className="transcript-content">
              {selectedSnapshot?.attention.map((request) => <AttentionCard key={request.id} request={request} />)}
              {!selectedSnapshot ? (
                <div className="loading-state"><LoaderCircle className="spin" /> Loading transcript…</div>
              ) : searching ? (
                <div className="message-list">
                  {visibleMessages!.map((message) => (
                    <TranscriptEntry key={message.id} message={message} agentName={selectedAgent.name} searchTerm={normalizedQuery} />
                  ))}
                  {!visibleMessages!.length && <div className="empty-transcript"><p>No messages match that search.</p></div>}
                </div>
              ) : (
                <div className="message-list" role="log" aria-live="off">
                  {selectedSnapshot.messages.map((message) => (
                    <TranscriptEntry key={message.id} message={message} agentName={selectedAgent.name} />
                  ))}
                  {pendingMessages.map((message) => (
                    <article key={message.id} className="message user pending" aria-label="Sending">
                      <div className="message-author">
                        <User aria-hidden="true" />
                        <span>You</span>
                      </div>
                      <div className="message-body">
                        <TranscriptImages
                          images={(message.attachments ?? []).flatMap((attachment, index) => attachment.previewUrl
                            ? [{ id: `${message.id}:${index}`, src: attachment.previewUrl }]
                            : [])}
                        />
                        {message.text && <p>{message.text}</p>}
                      </div>
                    </article>
                  ))}
                  {!selectedSnapshot.messages.length && !pendingMessages.length && <div className="empty-transcript"><p>Start a conversation with {selectedAgent.name}.</p></div>}
                </div>
              )}
            </div>
          </div>
          {!following && unseen > 0 && (
            <button
              className="jump-latest"
              onClick={() => {
                setFollowing(true);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
            ><ArrowDown /> Latest ({unseen})</button>
          )}
          <GoalStrip goal={selectedSnapshot?.goal} />
          <Composer key={selectedAgent.id} />
        </>
      )}
    </section>
  );
}
