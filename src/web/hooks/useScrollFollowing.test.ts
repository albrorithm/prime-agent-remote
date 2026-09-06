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

  /* iOS can clamp the first pin against a scroll range it has not updated
     yet, so the pin is taken again on the next frames. Here the first write is
     made to fail the way the phone fails it: the range grows only afterwards. */
  it("pins to the bottom again on the next frame, but only while still following", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { result, rerender } = renderHook((props) => useScrollFollowing(props), {
        initialProps: baseOptions(),
      });
      const scroller = document.createElement("div");
      let range = 0;
      // The scroll range the compositor knows about: nothing until a frame has passed.
      let knownMax = 0;
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => range,
        set: (value: number) => { range = Math.min(value, knownMax); },
      });
      Object.defineProperty(result.current.scrollRef, "current", { configurable: true, value: scroller, writable: true });

      rerender(baseOptions({ renderedMessageCount: 3 }));
      // The first write was clamped away, exactly as on the phone.
      expect(scroller.scrollTop).toBe(0);
      expect(frames.length).toBeGreaterThan(0);
      knownMax = 1000;
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      expect(scroller.scrollTop).toBe(1000);

      // A reader who scrolled up between frames is not yanked back down.
      range = 0;
      Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 300, set: (value: number) => { range = value; } });
      act(() => {
        Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 100, set: (value: number) => { range = value; } });
        result.current.updateFollowing();
      });
      rerender(baseOptions({ renderedMessageCount: 4 }));
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      expect(range).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
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
