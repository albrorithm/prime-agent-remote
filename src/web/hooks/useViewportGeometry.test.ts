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
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
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
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
  });

  it("shrinks the shell to sit on the keyboard and drops the composer inset", () => {
    const env = geometryEnvironment();
    const { scroll } = install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("500px");
    expect(env.properties.get("--viewport-top")).toBe("0px");
    expect(env.properties.get("--composer-safe-bottom")).toBe("0px");
    expect(scroll).not.toHaveBeenCalled();
  });

  // A page WebKit left displaced is still compensated — but only once the
  // offset has held still. The height does not wait for it.
  it("absorbs a page shift once it has settled", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 500;
    env.viewport.offsetTop = 300;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-top")).toBe("300px");
    expect(env.properties.get("--viewport-height")).toBe("500px");
    expect(env.properties.get("--composer-safe-bottom")).toBe("0px");
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
    // ...while the height it is animating toward is applied the whole way down.
    expect(env.properties.get("--viewport-height")).toBe("500px");
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
    expect(env.properties.get("--composer-safe-bottom")).toBe("0px");

    env.documentTarget.activeElement = null;
    env.viewport.height = 800;
    env.viewport.offsetTop = 0;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("800px");
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
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
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
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
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
  });

  // A hardware keyboard's accessory bar shrinks the viewport by ~55px. The
  // shell follows it, but that is not tall enough to spend the home-indicator
  // inset on.
  it("follows a short accessory bar without dropping the composer inset", () => {
    const env = geometryEnvironment();
    install(env);
    env.documentTarget.activeElement = focusedComposer;
    env.viewport.height = 745;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--viewport-height")).toBe("745px");
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
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
