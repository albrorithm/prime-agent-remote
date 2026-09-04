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
    // The scroller mounts with the selected agent, and an app that started
    // with no session has none to observe until one is picked; keyed on
    // nothing, this ran once against an empty ref and stayed inert.
  }, [selectedAgentId]);

  // Images load lazily, so scrolling up through history loads them as they
  // come into view. A reader who is not following has nothing new: the
  // message the image belongs to was counted when it arrived. Only a
  // follower has to be re-pinned, because the row just grew under them.
  function handleTranscriptImageLoad() {
    const element = scrollRef.current;
    if (!element || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
    setUnseen(0);
  }

  function updateFollowing() {
    const element = scrollRef.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
  }

  // Setting `following` is the jump: the effect above pins the scroller on
  // the next commit. A smooth `scrollTo` here was cancelled by that instant
  // one before a single frame of it played.
  function jumpToLatest() {
    setFollowing(true);
  }

  return { scrollRef, following, unseen, handleTranscriptImageLoad, updateFollowing, jumpToLatest };
}
