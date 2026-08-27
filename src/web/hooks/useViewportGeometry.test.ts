import { describe, expect, it, vi } from "vitest";
import { installViewportGeometry, readGeometry } from "./useViewportGeometry";

type Listener = EventListenerOrEventListenerObject;

function eventTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(name: string, listener: Listener) {
      const current = listeners.get(name) ?? new Set<Listener>();
      current.add(listener);
      listeners.set(name, current);
    },
    removeEventListener(name: string, listener: Listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name: string) {
      const event = new Event(name);
      for (const listener of listeners.get(name) ?? []) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, current) => total + current.size, 0);
    },
  };
}

/* A virtual clock, not just a queue. The hook decides whether a viewport offset
   is a displaced page or one frame of a keyboard animation by how long it has
   lasted, so a drain that ran every callback at time zero could not tell those
   two apart — and that distinction is the whole point. Timers fire in due-time
   order and carry the clock with them. */
function queues() {
  let next = 1;
  let clock = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, FrameRequestCallback>();
  return {
    timers,
    frames,
    now: () => clock,
    schedule(callback: () => void, delay: number) {
      const id = next++;
      timers.set(id, { at: clock + delay, callback });
      return id;
    },
    cancel(handle: unknown) {
      timers.delete(Number(handle));
    },
    frame(callback: FrameRequestCallback) {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(handle: unknown) {
      frames.delete(Number(handle));
    },
    /** Run every frame callback without advancing the clock. */
    drainFrames() {
      let steps = 0;
      while (frames.size > 0) {
        if (steps++ > 80) throw new Error("Frames did not settle");
        const framed = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
        if (!framed) return;
        frames.delete(framed[0]);
        framed[1](0);
      }
    },
    drain() {
      let steps = 0;
      while (timers.size > 0 || frames.size > 0) {
        if (steps++ > 120) throw new Error("Viewport geometry did not settle");
        this.drainFrames();
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) continue;
        timers.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].callback();
      }
    },
  };
}

function geometryEnvironment() {
  const viewportEvents = eventTarget();
  const windowEvents = eventTarget();
  const documentEvents = eventTarget();
  const properties = new Map<string, string>();
  const viewport = Object.assign(viewportEvents, { height: 800, scale: 1, offsetTop: 0, pageTop: 0 });
  const windowTarget = Object.assign(windowEvents, { scrollY: 0 });
  const documentTarget = Object.assign(documentEvents, {
    visibilityState: "visible",
    activeElement: null as { matches: (selector: string) => boolean } | null,
    documentElement: {
      clientHeight: 800,
      style: {
        setProperty(name: string, value: string) { properties.set(name, value); },
        removeProperty(name: string) { properties.delete(name); },
      },
    },
  });
  const work = queues();
  return { viewport, windowTarget, documentTarget, properties, work };
}

function install(env: ReturnType<typeof geometryEnvironment>, scroll = vi.fn()) {
  const cleanup = installViewportGeometry({
    viewport: env.viewport as unknown as VisualViewport,
    windowTarget: env.windowTarget as unknown as Window,
    documentTarget: env.documentTarget as unknown as Document,
    scroll,
    now: env.work.now,
    schedule: env.work.schedule,
    cancel: env.work.cancel,
    frame: env.work.frame,
    cancelFrame: env.work.cancelFrame,
  });
  env.work.drain();
  return { cleanup, scroll };
}

const focusedComposer = { matches: () => true };

describe("readGeometry", () => {
  it("reports the visible rectangle and the keyboard height", () => {
    const viewport = { height: 500, offsetTop: 0, scale: 1 } as VisualViewport;
    expect(readGeometry(viewport, 800)).toEqual({ top: 0, height: 500, keyboard: 300 });
  });

  // The two ways iOS presents a keyboard differ only in whether it also scrolled
  // the page. Both must report the same keyboard height, or the scrolled one
  // reads as "no keyboard" and the composer keeps an inset it should not have.
  it("reports the same keyboard height when WebKit has scrolled the page instead", () => {
    const viewport = { height: 500, offsetTop: 300, scale: 1 } as VisualViewport;
    expect(readGeometry(viewport, 800)).toEqual({ top: 300, height: 500, keyboard: 300 });
  });

  it("refuses to track a pinch-zoomed viewport", () => {
    const viewport = { height: 400, offsetTop: 120, scale: 2.5 } as VisualViewport;
    expect(readGeometry(viewport, 800)).toBeNull();
  });

  it("refuses a viewport that has not been measured yet", () => {
    expect(readGeometry({ height: 0, offsetTop: 0, scale: 1 } as VisualViewport, 800)).toBeNull();
  });

  // A layout viewport reported taller than the screen is the launch bug: the
  // shell must take the screen's height, not the reported one.
  it("takes the visible height when the layout viewport is reported too tall", () => {
    const viewport = { height: 800, offsetTop: 0, scale: 1 } as VisualViewport;
    expect(readGeometry(viewport, 932)).toMatchObject({ height: 800 });
  });
});

describe("viewport geometry", () => {
  it("does nothing without a visual viewport", () => {
    const cleanup = installViewportGeometry({ viewport: undefined, windowTarget: undefined });
    expect(cleanup).toBeTypeOf("function");
    expect(() => cleanup()).not.toThrow();
  });

  it("publishes the visible rectangle on install", () => {
    const env = geometryEnvironment();
    install(env);
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(env.properties.get("--viewport-top")).toBe("0px");
    expect(env.properties.has("--keyboard-height")).toBe(false);
  });

  // The launch bug: a layout viewport taller than the screen leaves a shell at
  // `inset: 0` hanging off the display. The published height is the screen's.
  it("sizes the shell to the screen when the layout viewport is stale at launch", () => {
    const env = geometryEnvironment();
    env.documentTarget.documentElement.clientHeight = 932;
    env.viewport.height = 800;
    install(env);
    expect(env.properties.get("--viewport-height")).toBe("800px");
    // No editable is focused, so a stale layout viewport must not read as a keyboard.
    expect(env.properties.has("--keyboard-height")).toBe(false);
  });

  /* The shell is deliberately NOT resized while the keyboard is up, and a page
     iOS has scrolled is deliberately NOT put back. iOS lifts the composer clear
     of the keyboard by scrolling, the absolutely positioned shell travels with
     it, and the header scrolls away — one motion. Holding the shell still
     against that scroll is what turned it into two, which is the jump.
     --keyboard-height is still published, because the composer's inset is about
     the strip being covered, not about where the page is. */
  it("leaves the shell alone while the keyboard is up, and never scrolls it back", () => {
    const env = geometryEnvironment();
    const { scroll } = install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.windowTarget.scrollY = 465;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(env.properties.get("--keyboard-height")).toBe("300px");
    expect(scroll).not.toHaveBeenCalled();
  });

  /* iOS does not reliably blur a field when its keyboard goes away — tapping
     Done, or swiping the keyboard down, can leave the textarea focused with
     nothing on screen. The release used to be `focusedEditable() || ...`, which
     in that state re-asserted itself on every measurement and never let go: the
     shell never went back to full height and the page iOS had scrolled was
     never put back, so the header stayed gone for the rest of the session. */
  it("lets go of a keyboard that closed while the field kept focus", () => {
    const env = geometryEnvironment();
    const { scroll } = install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.windowTarget.scrollY = 336;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--keyboard-height")).toBe("300px");
    expect(scroll).not.toHaveBeenCalled();

    // The keyboard goes; the composer keeps focus, as iOS often leaves it.
    env.viewport.height = 800;
    env.viewport.emit("resize");
    env.work.drain();

    expect(env.properties.has("--keyboard-height")).toBe(false);
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(scroll).toHaveBeenCalledWith(0, 0);
  });

  /* The other half: a full-height reading DURING the animation is one frame
     between two others, not an ending. Believing it would put the clamp back —
     a scroll correction fired against a scroll iOS is still making, which is
     the jump this whole file exists to have stopped making. */
  it("does not mistake a frame of the animation for the keyboard leaving", () => {
    const env = geometryEnvironment();
    const { scroll } = install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.windowTarget.scrollY = 336;

    // Full height, then shrinking, then full again — all inside KEYBOARD_GONE_MS.
    for (const height of [800, 640, 800, 520]) {
      env.viewport.height = height;
      env.viewport.emit("resize");
      env.work.drainFrames();
    }
    expect(scroll).not.toHaveBeenCalled();
    expect(env.properties.get("--viewport-height")).toBe("800px");
  });

  // A page a launch or a resume left displaced is still compensated — but only
  // once the offset has held still. The height does not wait for it. Nothing is
  // focused here: that is what makes this a displaced page rather than a lift.
  it("absorbs a page shift once it has settled", () => {
    const env = geometryEnvironment();
    install(env);
    env.viewport.height = 500;
    env.viewport.offsetTop = 300;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("300px");
    expect(env.properties.get("--viewport-height")).toBe("500px");
    expect(env.properties.has("--keyboard-height")).toBe(false);
  });

  /* The reported bug, and the reason duration alone cannot decide this. iOS runs
     the keyboard's height and the scroll that lifted the focused field as two
     independent animations. Let the height settle first and the page can stay
     lifted well past OFFSET_SETTLE_MS with no further events — the offset is
     real every time it is read, and believing it pushes every fixed layer down
     until the relax arrives and snaps it back. On the phone that is the header
     visibly detaching from the top of the screen and then jumping into place. */
  it("never compensates a page lift while the keyboard is up, however long it lasts", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.offsetTop = 150;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("0px");

    // Long past the settle window, still lifted, still nothing to compensate.
    for (let round = 0; round < 4; round += 1) {
      env.viewport.emit("resize");
      env.work.drain();
      expect(env.properties.get("--viewport-top")).toBe("0px");
    }

    // And the relax, when it finally lands, changes nothing — there is no
    // committed offset left to snap back from.
    env.viewport.offsetTop = 0;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("0px");
  });

  /* The gate is "a keyboard is being tracked", which a focused editable turns on
     even with no viewport shrink at all — an iPad with a hardware keyboard. The
     shell is sized to the visual viewport there too, so there is still no hidden
     field for iOS to scroll to and still nothing to compensate. */
  it("holds the origin for a lift with a field focused and no keyboard at all", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.offsetTop = 200;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("0px");
    expect(env.properties.has("--keyboard-height")).toBe(false);

    // ...and it is not sticky: focus leaving hands a genuinely displaced page
    // straight back to the settle logic.
    env.documentTarget.activeElement = null;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("200px");
  });

  // The same lift with focus already gone but the keyboard still up: it is the
  // keyboard, not the focus, that rules the offset out.
  it("holds the origin for a lift under a keyboard that has lost focus", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    env.documentTarget.activeElement = null;
    env.viewport.offsetTop = 150;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("0px");
  });

  // The regression this guards: iOS scrolls the page to lift the focused field
  // clear of the keyboard and relaxes it again as the keyboard finishes, and
  // reports both a frame late. Following that offset live walked the whole
  // shell down the screen and back — a visible dip in the header.
  it("ignores the offset thrown off while the keyboard animates", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    const seen: Array<string | undefined> = [];
    for (const [height, offsetTop] of [[750, 180], [640, 290], [560, 200], [510, 80], [500, 0]]) {
      env.viewport.height = height;
      env.viewport.offsetTop = offsetTop;
      env.viewport.emit("resize");
      env.work.drainFrames();
      seen.push(env.properties.get("--viewport-top"));
    }
    env.work.drain();
    seen.push(env.properties.get("--viewport-top"));
    expect(seen).toEqual(["0px", "0px", "0px", "0px", "0px", "0px"]);
    // ...and the height is left alone throughout, along with everything else.
    expect(env.properties.get("--viewport-height")).toBe("800px");
  });

  // Coming back to rest is the one offset change that is applied at once:
  // it can never be wrong, and being late leaves the app displaced.
  it("returns to the origin immediately when the offset clears", () => {
    const env = geometryEnvironment();
    install(env);
    env.viewport.offsetTop = 300;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("300px");

    env.viewport.offsetTop = 0;
    env.viewport.emit("resize");
    env.work.drainFrames();
    expect(env.properties.get("--viewport-top")).toBe("0px");
  });

  // ...and it must not fire when there is nothing to undo, or every scroll
  // event becomes a scrollTo that provokes the next one.
  it("does not touch the scroll position when the page is already at the origin", () => {
    const env = geometryEnvironment();
    const scroll = vi.fn();
    install(env, scroll);
    scroll.mockClear();

    env.windowTarget.emit("scroll");
    env.work.drain();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("still puts a real document scroll back to the origin", () => {
    const env = geometryEnvironment();
    env.windowTarget.scrollY = 64;
    const { scroll } = install(env);
    expect(scroll).toHaveBeenCalledWith(0, 0);
  });

  // scrollTo cannot move the visual viewport inside the layout viewport, so
  // calling it for that offset only fights WebKit mid-animation.
  it("does not fight WebKit with scrollTo over a visual-viewport offset", () => {
    const env = geometryEnvironment();
    const { scroll } = install(env);
    env.viewport.offsetTop = 300;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("restores the composer inset and the full height when the keyboard closes", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--keyboard-height")).toBe("300px");

    env.documentTarget.activeElement = null;
    env.viewport.height = 800;
    env.viewport.offsetTop = 0;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(env.properties.has("--keyboard-height")).toBe(false);
  });

  // A keyboard dismissed by dragging leaves focus on the textarea. The height
  // coming back is the signal, not the focus.
  it("restores the inset when the keyboard is dragged away with focus retained", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    env.viewport.height = 800;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.has("--keyboard-height")).toBe(false);
  });

  // An iPad floating keyboard does not resize the visual viewport at all, so
  // nothing may move.
  it("leaves the layout alone for a keyboard that does not resize the viewport", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(env.properties.has("--keyboard-height")).toBe(false);
  });

  // A hardware keyboard's accessory bar shrinks the viewport by ~55px, and the
  // shell follows it. It used to be held below the threshold and so left the
  // composer's inset alone; now it spends it, which is the truer answer — 55px
  // of bar covers the home-indicator strip just as a keyboard does, and there
  // is as little left to clear either way.
  it("spends the inset against a short accessory bar too", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 745;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(env.properties.get("--keyboard-height")).toBe("55px");
  });

  /* The bug this replaced: the inset was switched off whole the first frame the
     keyboard measured over 80px, so the composer lost 19px of
     height in one step partway up. What has to be true instead is that the
     published height never skips the range the inset is spent over — every
     frame of a rising keyboard is reported, from the first one. */
  it("reports the keyboard from its first frame, without a threshold to jump", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    const seen: Array<string | undefined> = [];
    for (const keyboard of [4, 12, 21, 30, 44, 88, 180, 300]) {
      env.viewport.height = 800 - keyboard;
      env.viewport.emit("resize");
      env.work.drainFrames();
      seen.push(env.properties.get("--keyboard-height"));
    }
    expect(seen).toEqual(["4px", "12px", "21px", "30px", "44px", "88px", "180px", "300px"]);
  });

  // A stale layout viewport at launch is the case the focus gate is carrying
  // now that height no longer decides entry: nothing is focused, so a viewport
  // reported 300px short must still not read as a keyboard.
  it("does not read an unfocused shrunken viewport as a keyboard at any height", () => {
    const env = geometryEnvironment();
    install(env);
    for (const keyboard of [40, 120, 300]) {
      env.viewport.height = 800 - keyboard;
      env.viewport.emit("resize");
      env.work.drain();
      expect(env.properties.has("--keyboard-height")).toBe(false);
    }
  });

  // Focus can move to a button with the keyboard still up — the send control,
  // the options menu. The keyboard is still there and the inset stays spent.
  it("keeps reporting the keyboard when focus leaves the field for a button", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    env.documentTarget.activeElement = { matches: () => false };
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--keyboard-height")).toBe("300px");
  });

  /* The same move, but over an accessory bar rather than a full keyboard. A
     height gate at 80px released here, putting the inset back under a bar that
     is still covering the strip — and, on a falling keyboard, snapping it back
     whole at 80px on the way down. Believing a keyboard until the viewport is
     its full height again is what makes both continuous. */
  it("keeps the inset spent under an accessory bar after focus moves away", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 745;
    env.viewport.emit("resize");
    env.work.drain();
    env.documentTarget.activeElement = { matches: () => false };
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--keyboard-height")).toBe("55px");
  });

  // A keyboard falling away with focus already gone still has to report every
  // height on the way down, for the same reason it does on the way up.
  it("reports a blurred keyboard all the way down, not down to a threshold", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    env.documentTarget.activeElement = null;
    const seen: Array<string | undefined> = [];
    for (const keyboard of [220, 120, 79, 40, 18, 6, 0]) {
      env.viewport.height = 800 - keyboard;
      env.viewport.emit("resize");
      env.work.drainFrames();
      seen.push(env.properties.get("--keyboard-height"));
    }
    expect(seen).toEqual(["220px", "120px", "79px", "40px", "18px", "6px", undefined]);
  });

  // Pinch-zoom shrinks the visual viewport exactly as a keyboard does. Tracking
  // it would shrink the app under the reader's magnifier.
  it("hands the layout back to CSS while the page is pinch-zoomed", () => {
    const env = geometryEnvironment();
    install(env);
    env.viewport.scale = 2;
    env.viewport.height = 400;
    env.viewport.offsetTop = 120;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.has("--viewport-height")).toBe(false);
    expect(env.properties.has("--viewport-top")).toBe(false);

    env.viewport.scale = 1;
    env.viewport.height = 800;
    env.viewport.offsetTop = 0;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
  });

  it("re-measures after a resume and after rotation", () => {
    const env = geometryEnvironment();
    install(env);
    env.viewport.height = 600;
    env.documentTarget.emit("visibilitychange");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("600px");

    env.viewport.height = 400;
    env.windowTarget.emit("orientationchange");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("400px");
  });

  it("skips the re-measure while the document is hidden", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.visibilityState = "hidden";
    env.viewport.height = 600;
    env.documentTarget.emit("visibilitychange");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
  });

  it("releases every listener, timer and property on cleanup", () => {
    const env = geometryEnvironment();
    const { cleanup } = install(env);
    env.viewport.height = 500;
    env.viewport.emit("resize");
    cleanup();
    expect(env.viewport.listenerCount()).toBe(0);
    expect(env.windowTarget.listenerCount()).toBe(0);
    expect(env.documentTarget.listenerCount()).toBe(0);
    expect(env.work.timers.size).toBe(0);
    expect(env.work.frames.size).toBe(0);
    expect(env.properties.size).toBe(0);
  });
});
