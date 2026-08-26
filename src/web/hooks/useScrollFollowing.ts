import { useEffect, useRef, useState } from "react";

export function countUnseen(previousCount: number, currentCount: number): number {
  return currentCount > previousCount ? currentCount - previousCount : 0;
}

interface UseScrollFollowingOptions {
  selectedAgentId: string | null;
  selectedSnapshotAgentId: string | null;
  renderedMessageCount: number;
  lastContentKey: string;
  snapshotAttention: number;
}

export function useScrollFollowing({
  selectedAgentId,
  selectedSnapshotAgentId,
  renderedMessageCount,
  lastContentKey,
  snapshotAttention,
}: UseScrollFollowingOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const previousCount = useRef(0);
  const previousContentKey = useRef("");
  const previousAttention = useRef(0);
  const previousAgentId = useRef<string | null>(null);
  const previousSnapshotAgentId = useRef<string | null>(null);
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (following) {
      element.scrollTop = element.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((count) => count + countUnseen(previousCount.current, renderedMessageCount));
    }
    previousCount.current = renderedMessageCount;
  }, [renderedMessageCount, following]);

  useEffect(() => {
    const changed = previousContentKey.current !== lastContentKey;
    previousContentKey.current = lastContentKey;
    if (!changed) return;
    const element = scrollRef.current;
    if (following) {
      if (element) element.scrollTop = element.scrollHeight;
    } else {
      // A streamed reply can grow without increasing the message count.
      setUnseen((count) => Math.max(1, count));
    }
  }, [lastContentKey, following]);

  // Reset scroll-following state when switching agents so a new session's
  // history doesn't register as "unseen" and the view jumps to its bottom.
  // A selected agent can render before its snapshot loads, so baseline again
  // when that snapshot first arrives. This effect must run before vibration.
  useEffect(() => {
    const agentId = selectedAgentId;
    const snapshotAgentId = selectedSnapshotAgentId;
    const baselineSnapshotAgentId = agentId && snapshotAgentId === agentId ? agentId : null;
    const agentChanged = previousAgentId.current !== agentId;
    const snapshotChanged = previousSnapshotAgentId.current !== baselineSnapshotAgentId;
    if (!agentChanged && !snapshotChanged) return;

    previousAgentId.current = agentId;
    previousSnapshotAgentId.current = baselineSnapshotAgentId;
    previousCount.current = renderedMessageCount;
    previousContentKey.current = lastContentKey;
    previousAttention.current = snapshotAttention;
    if (agentChanged) {
      setFollowing(true);
      setUnseen(0);
    }
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [selectedAgentId, selectedSnapshotAgentId, renderedMessageCount, lastContentKey, snapshotAttention]);

  useEffect(() => {
    if (snapshotAttention > previousAttention.current && typeof navigator.vibrate === "function") {
      navigator.vibrate(30);
    }
    previousAttention.current = snapshotAttention;
  }, [snapshotAttention]);

  // The shell is sized to the visible rectangle, so the transcript is the row
  // that gives up height when the keyboard opens. A shorter scroll box keeps
  // its scrollTop, which silently un-pins a reader who was at the bottom — the
  // composer rises and the latest message slides out from behind it. Re-pin on
  // any height change, which covers rotation and the drawers too.
  // ResizeObserver is absent in jsdom; without it this is simply inert there,
  // which is the honest outcome for a test environment with no layout.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver !== "function") return;
    let previousHeight = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = element.clientHeight;
      if (height === previousHeight) return;
      previousHeight = height;
      if (followingRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function handleTranscriptImageLoad() {
    const element = scrollRef.current;
    if (!element) return;
    if (followingRef.current) {
      element.scrollTop = element.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((count) => Math.max(1, count));
    }
  }

  function updateFollowing() {
    const element = scrollRef.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
  }

  function jumpToLatest() {
    setFollowing(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  return { scrollRef, following, unseen, handleTranscriptImageLoad, updateFollowing, jumpToLatest };
}
