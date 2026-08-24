import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { countUnseen, useScrollFollowing } from "./useScrollFollowing";

describe("unseen counting", () => {
  it("counts only genuinely new messages", () => {
    expect(countUnseen(3, 5)).toBe(2);
  });

  it("never counts downward or on equal counts", () => {
    expect(countUnseen(5, 5)).toBe(0);
    expect(countUnseen(5, 3)).toBe(0);
  });

  it("accumulates across polls without phantom increments", () => {
    let previous = 0;
    let total = 0;
    for (const current of [1, 1, 2, 2, 7]) {
      total += countUnseen(previous, current);
      previous = current;
    }
    expect(total).toBe(7);
  });
});

function baseOptions(overrides: Partial<Parameters<typeof useScrollFollowing>[0]> = {}) {
  return {
    selectedAgentId: "agent-a",
    selectedSnapshotAgentId: "agent-a",
    renderedMessageCount: 1,
    lastContentKey: "seed",
    snapshotAttention: 0,
    ...overrides,
  };
}

function constrainScroll(element: HTMLElement) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
}

describe("useScrollFollowing", () => {
  it("scrolls to bottom and clears unseen while following as messages grow", () => {
    const { result, rerender } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions(),
    });
    const scroller = document.createElement("div");
    constrainScroll(scroller);
    Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });

    rerender(baseOptions({ renderedMessageCount: 3 }));
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(result.current.unseen).toBe(0);
  });

  it("accumulates unseen once following is turned off", () => {
    const { result, rerender } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions(),
    });
    const scroller = document.createElement("div");
    constrainScroll(scroller);
    Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });
    scroller.scrollTop = 100;

    act(() => {
      result.current.updateFollowing();
    });
    expect(result.current.following).toBe(false);

    rerender(baseOptions({ renderedMessageCount: 4 }));
    expect(result.current.unseen).toBe(3);
  });

  it("bumps unseen to at least 1 when a streamed reply grows without a new message", () => {
    const { result, rerender } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions(),
    });
    const scroller = document.createElement("div");
    constrainScroll(scroller);
    Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });
    scroller.scrollTop = 100;
    act(() => {
      result.current.updateFollowing();
    });

    rerender(baseOptions({ lastContentKey: "seed-more-tokens" }));
    expect(result.current.unseen).toBe(1);
  });

  it("resets following and clears unseen when the selected agent changes", () => {
    const { result, rerender } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions(),
    });
    const scroller = document.createElement("div");
    constrainScroll(scroller);
    Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });
    scroller.scrollTop = 100;
    act(() => {
      result.current.updateFollowing();
    });
    rerender(baseOptions({ renderedMessageCount: 5 }));
    expect(result.current.unseen).toBeGreaterThan(0);

    rerender(baseOptions({ selectedAgentId: "agent-b", selectedSnapshotAgentId: "agent-b", renderedMessageCount: 8 }));
    expect(result.current.following).toBe(true);
    expect(result.current.unseen).toBe(0);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("does not vibrate for attention already present when a session is selected", () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });

    const { rerender } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions({ selectedAgentId: "agent-b", selectedSnapshotAgentId: null, snapshotAttention: 0 }),
    });
    expect(vibrate).not.toHaveBeenCalled();

    rerender(baseOptions({ selectedAgentId: "agent-b", selectedSnapshotAgentId: "agent-b", snapshotAttention: 1 }));
    expect(vibrate).not.toHaveBeenCalled();

    rerender(baseOptions({ selectedAgentId: "agent-b", selectedSnapshotAgentId: "agent-b", snapshotAttention: 2 }));
    expect(vibrate).toHaveBeenCalledWith(30);

    Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined });
  });

  it("jumpToLatest resumes following and scrolls smoothly", () => {
    const { result } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions(),
    });
    const scroller = document.createElement("div");
    constrainScroll(scroller);
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });
    scroller.scrollTop = 100;
    act(() => {
      result.current.updateFollowing();
    });
    expect(result.current.following).toBe(false);

    act(() => {
      result.current.jumpToLatest();
    });
    expect(result.current.following).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: scroller.scrollHeight, behavior: "smooth" });
  });

  it("handleTranscriptImageLoad clears unseen while following and bumps it otherwise", () => {
    const { result } = renderHook((props) => useScrollFollowing(props), {
      initialProps: baseOptions(),
    });
    const scroller = document.createElement("div");
    constrainScroll(scroller);
    Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });

    act(() => {
      result.current.handleTranscriptImageLoad();
    });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);

    scroller.scrollTop = 100;
    act(() => {
      result.current.updateFollowing();
    });
    act(() => {
      result.current.handleTranscriptImageLoad();
    });
    expect(result.current.unseen).toBe(1);
  });
});
