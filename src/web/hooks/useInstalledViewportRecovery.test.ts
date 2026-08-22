import { describe, expect, it, vi } from "vitest";
import { installInstalledViewportRecovery } from "./useInstalledViewportRecovery";

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

function queues() {
  let next = 1;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  return {
    timers,
    frames,
    schedule(callback: () => void) {
      const id = next++;
      timers.set(id, callback);
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
    drain() {
      let steps = 0;
      while (timers.size > 0 || frames.size > 0) {
        if (steps++ > 50) throw new Error("Viewport recovery did not settle");
        const timer = timers.entries().next().value as [number, () => void] | undefined;
        if (timer) {
          timers.delete(timer[0]);
          timer[1]();
          continue;
        }
        const framed = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
        if (framed) {
          frames.delete(framed[0]);
          framed[1](0);
        }
      }
    },
  };
}

function recoveryEnvironment() {
  const viewportEvents = eventTarget();
  const windowEvents = eventTarget();
  const documentEvents = eventTarget();
  const mobileEvents = eventTarget();
  const properties = new Map<string, string>();
  const viewport = Object.assign(viewportEvents, {
    height: 800,
    scale: 1,
    offsetTop: 0,
    pageTop: 0,
  });
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
  const mobileMedia = Object.assign(mobileEvents, { matches: true });
  const work = queues();
  return { viewport, windowTarget, documentTarget, mobileMedia, properties, work };
}

describe("installed viewport recovery", () => {
  it("does nothing outside installed display mode", () => {
    const cleanup = installInstalledViewportRecovery({ media: { matches: false } as MediaQueryList });
    expect(cleanup).toBeTypeOf("function");
    cleanup();
  });

  it("restores a stale visual viewport origin on launch and resume", () => {
    const env = recoveryEnvironment();
    env.windowTarget.scrollY = 64;
    env.viewport.offsetTop = 6;
    env.viewport.pageTop = 64;
    const scroll = vi.fn(() => {
      env.windowTarget.scrollY = 0;
      env.viewport.offsetTop = 0;
      env.viewport.pageTop = 0;
    });
    const cleanup = installInstalledViewportRecovery({
      media: { matches: true } as MediaQueryList,
      mobileMedia: env.mobileMedia as unknown as MediaQueryList,
      viewport: env.viewport as unknown as VisualViewport,
      documentTarget: env.documentTarget as unknown as Document,
      windowTarget: env.windowTarget as unknown as Window,
      scroll,
      schedule: env.work.schedule,
      cancel: env.work.cancel,
      frame: env.work.frame,
      cancelFrame: env.work.cancelFrame,
    });

    env.work.drain();
    expect(scroll).toHaveBeenCalledWith(0, 0);

    env.windowTarget.scrollY = 48;
    env.viewport.pageTop = 48;
    env.documentTarget.emit("visibilitychange");
    env.work.drain();
    expect(scroll).toHaveBeenCalledTimes(2);

    env.windowTarget.scrollY = 36;
    env.viewport.pageTop = 36;
    env.windowTarget.emit("pageshow");
    env.work.drain();
    expect(scroll).toHaveBeenCalledTimes(3);

    cleanup();
    expect(env.viewport.listenerCount()).toBe(0);
    expect(env.windowTarget.listenerCount()).toBe(0);
    expect(env.documentTarget.listenerCount()).toBe(0);
    expect(env.mobileMedia.listenerCount()).toBe(0);
  });

  it("removes extra composer inset only while the keyboard contracts the viewport", () => {
    const env = recoveryEnvironment();
    const scroll = vi.fn(() => {
      env.windowTarget.scrollY = 0;
      env.viewport.pageTop = 0;
    });
    const cleanup = installInstalledViewportRecovery({
      media: { matches: true } as MediaQueryList,
      mobileMedia: env.mobileMedia as unknown as MediaQueryList,
      viewport: env.viewport as unknown as VisualViewport,
      documentTarget: env.documentTarget as unknown as Document,
      windowTarget: env.windowTarget as unknown as Window,
      scroll,
      schedule: env.work.schedule,
      cancel: env.work.cancel,
      frame: env.work.frame,
      cancelFrame: env.work.cancelFrame,
    });
    env.work.drain();

    env.documentTarget.activeElement = { matches: () => true };
    env.viewport.height = 540;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.get("--composer-safe-bottom")).toBe("0px");
    expect(scroll).not.toHaveBeenCalled();

    env.documentTarget.activeElement = null;
    env.documentTarget.emit("focusout");
    env.work.drain();
    expect(env.properties.get("--composer-safe-bottom")).toBe("0px");

    env.windowTarget.scrollY = 40;
    env.viewport.pageTop = 40;
    env.viewport.height = 800;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
    expect(scroll).toHaveBeenCalledWith(0, 0);

    cleanup();
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);
  });

  it("does not treat pinch zoom as a keyboard contraction", () => {
    const env = recoveryEnvironment();
    const cleanup = installInstalledViewportRecovery({
      media: { matches: true } as MediaQueryList,
      mobileMedia: env.mobileMedia as unknown as MediaQueryList,
      viewport: env.viewport as unknown as VisualViewport,
      documentTarget: env.documentTarget as unknown as Document,
      windowTarget: env.windowTarget as unknown as Window,
      scroll: vi.fn(),
      schedule: env.work.schedule,
      cancel: env.work.cancel,
      frame: env.work.frame,
      cancelFrame: env.work.cancelFrame,
    });
    env.work.drain();

    env.documentTarget.activeElement = { matches: () => true };
    env.viewport.scale = 2;
    env.viewport.height = 540;
    env.viewport.emit("resize");
    env.work.drain();
    expect(env.properties.has("--composer-safe-bottom")).toBe(false);

    cleanup();
  });

  it("retries when iOS preserves a stale viewport origin", () => {
    const env = recoveryEnvironment();
    env.windowTarget.scrollY = 64;
    env.viewport.pageTop = 64;
    const scroll = vi.fn();
    const cleanup = installInstalledViewportRecovery({
      media: { matches: true } as MediaQueryList,
      mobileMedia: env.mobileMedia as unknown as MediaQueryList,
      viewport: env.viewport as unknown as VisualViewport,
      documentTarget: env.documentTarget as unknown as Document,
      windowTarget: env.windowTarget as unknown as Window,
      scroll,
      schedule: env.work.schedule,
      cancel: env.work.cancel,
      frame: env.work.frame,
      cancelFrame: env.work.cancelFrame,
    });

    env.work.drain();
    expect(scroll).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it("cancels pending work during StrictMode cleanup", () => {
    const env = recoveryEnvironment();
    const cleanup = installInstalledViewportRecovery({
      media: { matches: true } as MediaQueryList,
      mobileMedia: env.mobileMedia as unknown as MediaQueryList,
      viewport: env.viewport as unknown as VisualViewport,
      documentTarget: env.documentTarget as unknown as Document,
      windowTarget: env.windowTarget as unknown as Window,
      scroll: vi.fn(),
      schedule: env.work.schedule,
      cancel: env.work.cancel,
      frame: env.work.frame,
      cancelFrame: env.work.cancelFrame,
    });

    cleanup();
    expect(env.work.timers.size).toBe(0);
    expect(env.work.frames.size).toBe(0);
    expect(env.viewport.listenerCount()).toBe(0);
    expect(env.windowTarget.listenerCount()).toBe(0);
    expect(env.documentTarget.listenerCount()).toBe(0);
  });
});
