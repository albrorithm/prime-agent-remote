import { ArrowDown, Ban, Bot, Brain, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleMinus, CircleX, Hourglass, Info, ListTree, LoaderCircle, Menu, OctagonAlert, Search, User, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AgentSummary, ImageMimeType, TranscriptMessage } from "../../protocol";
import { useGateway } from "../gateway-store";
import { useReplyAnnouncer } from "../hooks/useReplyAnnouncer";
import { useScrollFollowing } from "../hooks/useScrollFollowing";
import { useSettings } from "../settings";
import { AttentionCard } from "./AttentionCard";
import { AgentFamilyPicker, AncestorMenu } from "./AgentFamilyPicker";
import { Composer } from "./Composer";
import { GoalStrip } from "./GoalStrip";
import { ImageViewer } from "./ImageViewer";
import { MessageActions } from "./MessageActions";
import { MessageContent } from "./MessageContent";
import { PythonCellRow } from "./PythonCellRow";
import { RefineRow } from "./RefineRow";
import { SwitchHapticButton } from "./SwitchHapticButton";
import { groupIntoTurns, TurnGroup } from "./TurnGroup";
import { agentStatus, type AgentStatusTone } from "./agent-status";
import { collectAgentDescendants } from "./agent-tree-utils";

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

// Tones differ by hue alone, which colorblind users can't rely on — every tone
// also gets its own glyph shape.
function StatusGlyph({ tone }: { tone: AgentStatusTone }) {
  if (tone === "attention") return <CircleAlert aria-hidden="true" />;
  if (tone === "failed") return <CircleX aria-hidden="true" />;
  if (tone === "stopped") return <Ban aria-hidden="true" />;
  if (tone === "inactive") return <CircleMinus aria-hidden="true" />;
  if (tone === "starting") return <Hourglass aria-hidden="true" />;
  if (tone === "working") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (tone === "blocked") return <OctagonAlert aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

/**
 * Keeps the agent-lineage scroller's fade mask off unless it's actually
 * clipping content, and always scrolls the current agent's name into view
 * when the selection changes (rather than leaving whatever end happened to
 * be onscreen from the previous agent).
 */
function useLineageOverflow(lineageKey: string, currentAgentId: string | null) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.scrollWidth > element.clientWidth + 1) element.setAttribute("data-overflowing", "true");
      else element.removeAttribute("data-overflowing");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [lineageKey]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollLeft = element.scrollWidth;
  }, [currentAgentId]);

  return ref;
}

interface TranscriptImageSource {
  id: string;
  mimeType: ImageMimeType;
  src: string;
}

function imageExtension(mimeType: ImageMimeType): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function TranscriptImage({
  image,
  index,
  onLoad,
}: {
  image: TranscriptImageSource;
  index: number;
  onLoad?: () => void;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    setUnavailable(false);
    setAttempt(0);
    setViewerOpen(false);
  }, [image.src]);
  if (unavailable) {
    return (
      <div className="message-image-unavailable">
        <span role="img" aria-label={`Attached image ${index + 1} is unavailable`}>Image unavailable</span>
        <button type="button" onClick={() => {
          setUnavailable(false);
          setAttempt((value) => value + 1);
        }}>Retry image</button>
      </div>
    );
  }
  const separator = image.src.includes("?") ? "&" : "?";
  const src = attempt ? `${image.src}${separator}retry=${attempt}` : image.src;
  const alt = `Attached image ${index + 1}`;
  return (
    <>
      <button
        className="message-image-trigger"
        type="button"
        aria-label={`View attached image ${index + 1}`}
        onClick={() => setViewerOpen(true)}
      >
        <img
          key={attempt}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={onLoad}
          onError={() => setUnavailable(true)}
        />
      </button>
      {viewerOpen && (
        <ImageViewer
          alt={alt}
          downloadName={`attached-image-${index + 1}.${imageExtension(image.mimeType)}`}
          onClose={() => setViewerOpen(false)}
          src={src}
        />
      )}
    </>
  );
}

function TranscriptImages({
  images,
  onLoad,
}: {
  images: TranscriptImageSource[];
  onLoad?: () => void;
}) {
  if (!images.length) return null;
  return (
    <div className={`message-images ${images.length === 1 ? "single" : "multiple"}`} aria-label={`${images.length} attached image${images.length === 1 ? "" : "s"}`} data-gesture-exclusion>
      {images.map((image, index) => <TranscriptImage key={image.id} image={image} index={index} onLoad={onLoad} />)}
    </div>
  );
}

/**
 * Last path segment of a working directory, matching the Prime Agent TUI, whose
 * window title is `APP_TITLE - sessionName - cwdBasename`. A trailing slash is
 * not a segment, and filesystem root stands for itself.
 */
export function cwdBasename(cwd: string | undefined): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Ids of the message rows that should print an author line: the first
 * message-shaped row, then every one whose speaker differs from the previous
 * message-shaped row. Timeline rows (thinking, tool, python, refine, notice,
 * error) are not messages and never break a run, so one answer interrupted by
 * tool calls stays a single attributed block instead of restating the agent's
 * name after every step.
 */
export function authorLineIds(messages: readonly TranscriptMessage[]): Set<string> {
  const ids = new Set<string>();
  let previousRole: TranscriptMessage["role"] | null = null;
  for (const message of messages) {
    if (message.presentation) continue;
    if (message.role !== previousRole) ids.add(message.id);
    previousRole = message.role;
  }
  return ids;
}

export function TranscriptEntry({
  message,
  agentName,
  searchTerm,
  showAuthor = true,
  onImageLoad,
}: {
  message: TranscriptMessage;
  agentName: string;
  searchTerm?: string;
  /** False for a message continuing the previous speaker's run. */
  showAuthor?: boolean;
  onImageLoad?: () => void;
}) {
  const { settings } = useSettings();
  const presentation = message.presentation;
  if (presentation?.kind === "thinking") {
    const full = presentation.full && presentation.full !== message.text ? presentation.full : null;
    if (full) {
      return (
        <details className="thinking-disclosure" data-gesture-exclusion>
          <summary className={`timeline-row thinking ${message.state}`} aria-label={`Thinking: ${message.text}. Expand for the full thought.`}>
            <Brain aria-hidden="true" />
            <strong className="timeline-preview"><HighlightedText text={message.text} term={searchTerm ?? ""} /></strong>
            <ChevronDown className="thinking-chevron" aria-hidden="true" />
          </summary>
          <p className="thinking-full">{full}</p>
        </details>
      );
    }
    return (
      <div className={`timeline-row thinking ${message.state}`} role="note" aria-label={`Thinking: ${message.text}`}>
        <Brain aria-hidden="true" />
        <strong className="timeline-preview"><HighlightedText text={message.text} term={searchTerm ?? ""} /></strong>
      </div>
    );
  }
  if (presentation?.kind === "python") {
    return <PythonCellRow message={message} presentation={presentation} />;
  }
  if (presentation?.kind === "refine") {
    return <RefineRow presentation={presentation} />;
  }
  if (presentation?.kind === "notice") {
    return (
      <div className={`timeline-row notice ${presentation.tone}`} role="note" aria-label={`${presentation.label}: ${message.text}`}>
        <Info aria-hidden="true" />
        <strong className="timeline-label">{presentation.label}</strong>
        <span className="timeline-separator" aria-hidden="true">·</span>
        <span className="timeline-preview"><HighlightedText text={message.text} term={searchTerm ?? ""} /></span>
      </div>
    );
  }
  if (presentation?.kind === "error") {
    return (
      <div className="error-row" role="note" aria-label={`${presentation.label}: ${message.text}`}>
        <OctagonAlert aria-hidden="true" />
        <div className="error-row-copy">
          <strong>{presentation.label}</strong>
          <p><HighlightedText text={message.text} term={searchTerm ?? ""} /></p>
        </div>
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
      {/* A continuation keeps the timestamp when the setting asks for one — the
          author line is the redundant part, not the clock. */}
      {showAuthor ? (
        <div className="message-author">
          {message.role === "user" ? <User aria-hidden="true" /> : <Bot aria-hidden="true" />}
          <span>{message.role === "user" ? "You" : agentName}</span>
          {settings.timestamps && <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
        </div>
      ) : settings.timestamps ? (
        <div className="message-author is-continuation">
          <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
      ) : null}
      <div className="message-body">
        <TranscriptImages
          onLoad={onImageLoad}
          images={(message.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            mimeType: attachment.mimeType,
            src: `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
          }))}
        />
        {/* Search mode intentionally renders matched bodies as flat plain-text <p> so highlights stay simple. */}
        {searchTerm !== undefined
          ? <p><HighlightedText text={message.text} term={searchTerm} /></p>
          : <MessageContent text={message.text || (message.state === "streaming" ? "Thinking…" : "")} />}
      </div>
      {message.state === "streaming" && <span className="streaming-indicator" aria-label="Streaming" />}
      {/* Search mode renders flattened plain text, so copying from it would hand
          back a different string than the message actually contains. */}
      {message.role === "assistant" && message.state === "complete" && searchTerm === undefined && (
        <MessageActions text={message.text} label={agentName} />
      )}
    </article>
  );
}

export function TranscriptPanel({ onOpenSessions, onOpenActivity }: TranscriptPanelProps) {
  const { selectedAgent, selectedSnapshot, pendingMessages, attentionCount, catalog, selectAgent, backend } = useGateway();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const messageCount = selectedSnapshot?.messages.length ?? 0;
  const renderedMessageCount = messageCount + pendingMessages.length;
  const lastMessage = selectedSnapshot?.messages.at(-1);
  const lastContentKey = `${lastMessage?.id ?? ""}\0${lastMessage?.text ?? ""}\0${pendingMessages.map((message) => `${message.id}:${message.text}:${message.attachments?.length ?? 0}`).join("|")}`;
  const lineage = useMemo(
    () => deriveAgentLineage(catalog.agents, selectedAgent?.id ?? null),
    [catalog.agents, selectedAgent?.id],
  );
  const childCount = selectedAgent ? catalog.agents.filter((agent) => agent.parentId === selectedAgent.id).length : 0;
  const snapshotAttention = selectedSnapshot?.attention.length ?? 0;
  const selectedStatus = selectedAgent ? agentStatus(selectedAgent) : null;
  const selectedDescendants = useMemo(
    () => (selectedAgent ? collectAgentDescendants(catalog.agents, selectedAgent.id) : []),
    [catalog.agents, selectedAgent?.id],
  );
  // The subagent pill already pulses when a descendant is working; showing the
  // status chip's own working glyph alongside it doubles up on the same signal.
  const pillShowsWorking = selectedDescendants.some((agent) => agent.activity === "working");
  const suppressWorkingChip = selectedStatus?.tone === "working" && pillShowsWorking;
  const lineageKey = lineage.map((agent) => `${agent.id}:${agent.name}`).join("|");
  const lineageRef = useLineageOverflow(lineageKey, selectedAgent?.id ?? null);
  const isDeepLineage = lineage.length > 3;
  const displayedLineage = isDeepLineage
    ? [lineage[0], lineage[lineage.length - 2], lineage[lineage.length - 1]]
    : lineage;
  const hiddenAncestors = isDeepLineage ? lineage.slice(1, lineage.length - 2) : [];

  const { scrollRef, following, unseen, handleTranscriptImageLoad, updateFollowing, jumpToLatest } = useScrollFollowing({
    selectedAgentId: selectedAgent?.id ?? null,
    selectedSnapshotAgentId: selectedSnapshot?.agentId ?? null,
    renderedMessageCount,
    lastContentKey,
    snapshotAttention,
  });

  const replyAnnouncement = useReplyAnnouncer(selectedAgent?.id ?? null, selectedAgent?.name, selectedSnapshot);

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
  }

  // Search is scoped to whichever transcript is on screen — carrying a query
  // or an open search box across an agent switch would silently search (or
  // look like it's searching) the wrong conversation.
  useEffect(() => {
    setSearchOpen(false);
    setQuery("");
  }, [selectedAgent?.id]);

  const normalizedQuery = query.trim().toLowerCase();
  const searching = searchOpen && Boolean(normalizedQuery);
  const visibleMessages: TranscriptMessage[] | null = searching && selectedSnapshot
    ? selectedSnapshot.messages.filter((message) => message.text.toLowerCase().includes(normalizedQuery))
    : null;

  // Every daemon tick full-replaces the messages array, so array identity is
  // the correct (and only meaningful) memo key.
  const snapshotMessages = selectedSnapshot?.messages;
  const turnItems = useMemo(() => groupIntoTurns(snapshotMessages ?? []), [snapshotMessages]);
  const authorIds = useMemo(() => authorLineIds(snapshotMessages ?? []), [snapshotMessages]);
  const lastItem = turnItems.at(-1);
  const lastTurnKey = lastItem?.kind === "turn" ? lastItem.key : null;
  const sessionRecap = selectedSnapshot?.dashboard?.recap;

  return (
    <section className="panel transcript-panel" aria-labelledby="transcript-heading">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={replyAnnouncement.key}>{replyAnnouncement.text}</span>
      </span>
      <header className="conversation-header">
        <SwitchHapticButton
          className="sessions-trigger"
          buttonClassName="icon-button"
          label={`Open sessions${attentionCount ? `, ${attentionCount} need attention` : ""}`}
          onActivate={onOpenSessions}
        >
          <Menu aria-hidden="true" />
          {attentionCount > 0 && <span className="icon-badge" aria-hidden="true">{attentionCount > 9 ? "9+" : attentionCount}</span>}
        </SwitchHapticButton>
        <nav className="agent-hierarchy" aria-label="Agent hierarchy" data-gesture-exclusion>
          <div className="agent-lineage" ref={lineageRef} role="group" aria-label="Agent ancestry" tabIndex={0}>
            {displayedLineage.map((agent, index) => (
              <Fragment key={agent.id}>
                {isDeepLineage && index === 1 && (
                  <AncestorMenu
                    ancestors={hiddenAncestors}
                    onSelect={(id) => void selectAgent(id)}
                    triggerLabel={`Open ${hiddenAncestors.length} hidden ancestor${hiddenAncestors.length === 1 ? "" : "s"}`}
                  />
                )}
                <span className="lineage-item">
                  {index > 0 && <ChevronRight className="lineage-separator" aria-hidden="true" />}
                  {index === displayedLineage.length - 1 ? (
                    // A root agent IS the session, so it titles by session name and
                    // carries the working directory the way the TUI does. A subagent
                    // titles by agent name — its lineage already names the session.
                    !agent.parentId && cwdBasename(agent.cwd) ? (
                      <span className="lineage-title">
                        <h1 id="transcript-heading" tabIndex={-1} title={agent.name}>{agent.name}</h1>
                        <span className="lineage-cwd" title={agent.cwd}>{cwdBasename(agent.cwd)}</span>
                      </span>
                    ) : (
                      <h1 id="transcript-heading" tabIndex={-1} title={agent.name}>{agent.name}</h1>
                    )
                  ) : (
                    <button onClick={() => void selectAgent(agent.id)} title={`Open ${agent.name}`}>{agent.name}</button>
                  )}
                </span>
              </Fragment>
            ))}
            {!lineage.length && <h1 id="transcript-heading" tabIndex={-1}>Prime Agent</h1>}
          </div>
          {selectedAgent && (
            <AgentFamilyPicker
              agents={catalog.agents}
              selectedAgent={selectedAgent}
              onSelect={(id) => void selectAgent(id)}
            />
          )}
        </nav>
        {!suppressWorkingChip && (
          <span
            className={`agent-status-chip ${selectedStatus?.tone ?? "idle"}`}
            role="img"
            aria-label={selectedStatus?.label ?? "No agent selected"}
            title={selectedStatus?.label ?? "No agent selected"}
          >
            <StatusGlyph tone={selectedStatus?.tone ?? "idle"} />
            <span className="agent-status-chip-label" aria-hidden="true">{selectedStatus?.label ?? "No agent selected"}</span>
          </span>
        )}
        {backend === "demo" && <span className="demo-badge">Demo</span>}
        <button
          className={`icon-button search-trigger ${searchOpen ? "active" : ""}`}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          aria-label={searchOpen ? "Close search" : "Search transcript"}
          aria-expanded={searchOpen}
        >
          {searchOpen ? <X /> : <Search />}
        </button>
        <button className="icon-button activity-trigger" onClick={onOpenActivity} aria-label={`Open session dashboard${childCount ? `, ${childCount} subagents` : ""}`}>
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
          <SwitchHapticButton label="Open sessions" onActivate={onOpenSessions}>
            Open sessions
          </SwitchHapticButton>
        </div>
      ) : (
        <>
          <div
            className="transcript-scroll"
            ref={scrollRef}
            onScroll={updateFollowing}
            style={{ touchAction: "pan-y" }}
            aria-label={`${selectedAgent.name} transcript`}
          >
            <div className="transcript-content">
              {selectedSnapshot?.attention.map((request) => <AttentionCard key={request.id} request={request} />)}
              {!selectedSnapshot ? (
                <div className="loading-state"><LoaderCircle className="spin" /> Loading transcript…</div>
              ) : searching ? (
                <div className="message-list">
                  {visibleMessages!.map((message) => (
                    <TranscriptEntry key={message.id} message={message} agentName={selectedAgent.name} searchTerm={normalizedQuery} onImageLoad={handleTranscriptImageLoad} />
                  ))}
                  {!visibleMessages!.length && (
                    <div className="empty-transcript">
                      <p>No messages match that search.</p>
                      <button type="button" onClick={() => setQuery("")}>Clear search</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="message-list" role="log" aria-live="off">
                  {turnItems.map((item) => item.kind === "turn" ? (
                    <TurnGroup
                      key={item.key}
                      turnId={item.turnId}
                      rows={item.rows}
                      recap={item.key === lastTurnKey ? sessionRecap : undefined}
                      renderRow={(message) => (
                        <TranscriptEntry key={message.id} message={message} agentName={selectedAgent.name} showAuthor={authorIds.has(message.id)} onImageLoad={handleTranscriptImageLoad} />
                      )}
                    />
                  ) : (
                    <TranscriptEntry key={item.key} message={item.row} agentName={selectedAgent.name} showAuthor={authorIds.has(item.row.id)} onImageLoad={handleTranscriptImageLoad} />
                  ))}
                  {pendingMessages.map((message) => (
                    <article key={message.id} className="message user pending" aria-label="Sending">
                      <div className="message-author">
                        <User aria-hidden="true" />
                        <span>You</span>
                      </div>
                      <div className="message-body">
                        <TranscriptImages
                          onLoad={handleTranscriptImageLoad}
                          images={(message.attachments ?? []).flatMap((attachment, index) => attachment.previewUrl
                            ? [{ id: `${message.id}:${index}`, mimeType: attachment.mimeType, src: attachment.previewUrl }]
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
              onClick={jumpToLatest}
            ><ArrowDown /> Latest ({unseen})</button>
          )}
          <GoalStrip goal={selectedSnapshot?.goal} />
          <Composer key={selectedAgent.id} />
        </>
      )}
    </section>
  );
}
