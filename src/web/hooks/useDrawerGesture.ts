import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export const DRAWER_DEAD_ZONE = 12;
export const DRAWER_PROGRESS_THRESHOLD = 0.35;
export const DRAWER_VELOCITY_THRESHOLD = 0.45;

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='button']",
  "[role='slider']",
  "[data-gesture-exclusion]",
].join(",");

interface DrawerGestureOptions {
  open: boolean;
  disabled?: boolean;
  onOpen: () => void;
  onClose: () => void;
}

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  startProgress: 0 | 1;
  locked: boolean;
  cancelled: boolean;
  target: Element;
  boundary: HTMLElement;
}

export function shouldIgnoreDrawerGesture(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(INTERACTIVE_SELECTOR)) return true;
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

export function horizontalScrollerConsumes(target: Element, boundary: HTMLElement, deltaX: number): boolean {
  let element: Element | null = target;
  while (element && element !== boundary) {
    if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) {
      if (deltaX > 0 && element.scrollLeft > 0) return true;
      if (deltaX < 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;
    }
    element = element.parentElement;
  }
  return false;
}

export function settleDrawer(startProgress: 0 | 1, progress: number, velocity: number): boolean {
  if (startProgress === 0) return progress >= DRAWER_PROGRESS_THRESHOLD || velocity >= DRAWER_VELOCITY_THRESHOLD;
  return progress > 1 - DRAWER_PROGRESS_THRESHOLD && velocity > -DRAWER_VELOCITY_THRESHOLD;
}

export function useDrawerGesture({ open, disabled = false, onOpen, onClose }: DrawerGestureOptions) {
  const active = useRef<ActiveGesture | null>(null);
  const latestProgress = useRef<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // While a locked drag owns the pointer, native scrolling must not claim
    // the gesture: a scroll start fires pointercancel and kills the drawer.
    const block = (event: TouchEvent) => {
      event.preventDefault();
    };
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [dragging]);

  const finish = (commit: boolean, clientX: number, timeStamp: number) => {
    const current = active.current;
    if (!current) return;
    const elapsed = Math.max(1, timeStamp - current.startedAt);
    const velocity = (clientX - current.startX) / elapsed;
    const value = latestProgress.current ?? current.startProgress;
    const shouldOpen = commit && current.locked
      ? settleDrawer(current.startProgress, value, velocity)
      : current.startProgress === 1;
    active.current = null;
    latestProgress.current = null;
    setDragging(false);
    setProgress(null);
    if (shouldOpen) onOpen();
    else onClose();
  };

  const handlers = useMemo(() => ({
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (disabled || !event.isPrimary || event.pointerType === "mouse" || shouldIgnoreDrawerGesture(event.target)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const startProgress = open ? 1 : 0;
      active.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: event.timeStamp,
        startProgress,
        locked: false,
        cancelled: false,
        target,
        boundary: event.currentTarget,
      };
      latestProgress.current = startProgress;
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const current = active.current;
      if (!current || current.pointerId !== event.pointerId || current.cancelled) return;
      const deltaX = event.clientX - current.startX;
      const deltaY = event.clientY - current.startY;
      if (!current.locked) {
        if (Math.abs(deltaX) < DRAWER_DEAD_ZONE && Math.abs(deltaY) < DRAWER_DEAD_ZONE) return;
        if (Math.abs(deltaY) >= Math.abs(deltaX) || (current.startProgress === 0 ? deltaX <= 0 : deltaX >= 0)) {
          current.cancelled = true;
          return;
        }
        if (horizontalScrollerConsumes(current.target, current.boundary, deltaX)) {
          current.cancelled = true;
          return;
        }
        current.locked = true;
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      const drawerWidth = Math.min(window.innerWidth * 0.88, 352);
      const next = Math.max(0, Math.min(1, current.startProgress + deltaX / drawerWidth));
      latestProgress.current = next;
      setProgress(next);
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      if (active.current?.pointerId !== event.pointerId) return;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      finish(true, event.clientX, event.timeStamp);
    },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
      if (active.current?.pointerId !== event.pointerId) return;
      finish(false, event.clientX, event.timeStamp);
    },
  }), [disabled, onClose, onOpen, open]);

  return { progress, dragging, handlers };
}
