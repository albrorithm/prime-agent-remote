import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

export interface OptionsMenu {
  optionsOpen: boolean;
  optionsMenuIndex: number;
  setOptionsMenuIndex: (index: number) => void;
  optionsMenuRef: RefObject<HTMLDivElement | null>;
  /** Closes the menu. When `restoreFocus` is true, focus returns to whatever triggered the open (microtask-deferred, matching the original inline behavior). */
  closeOptions: (restoreFocus: boolean) => void;
  toggleOptions: (source?: "button" | "switch") => void;
  onOptionsMenuKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

// `composerRef` and `textareaRef` are owned by Composer (the trigger button and
// textarea live outside this hook's own DOM), so they're passed in rather than
// created here.
export function useOptionsMenu(
  id: string,
  composerRef: RefObject<HTMLDivElement | null>,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): OptionsMenu {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsMenuIndex, setOptionsMenuIndex] = useState(0);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const optionsRestoreFocusRef = useRef<HTMLElement | null>(null);
  const focusOptionsOnOpenRef = useRef(false);

  useEffect(() => {
    setOptionsOpen(false);
    setOptionsMenuIndex(0);
  }, [id]);

  function closeOptions(restoreFocus: boolean) {
    focusOptionsOnOpenRef.current = false;
    setOptionsOpen(false);
    const restore = optionsRestoreFocusRef.current;
    optionsRestoreFocusRef.current = null;
    if (restoreFocus) queueMicrotask(() => restore?.focus({ preventScroll: true }));
  }

  function toggleOptions(source?: "button" | "switch") {
    if (optionsOpen) {
      closeOptions(true);
      return;
    }
    const trigger = composerRef.current?.querySelector<HTMLElement>(".composer-options-trigger") ?? null;
    optionsRestoreFocusRef.current = source === "button"
      ? trigger
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusOptionsOnOpenRef.current = source === "button";
    setOptionsMenuIndex(0);
    setOptionsOpen(true);
  }

  function enabledOptionsMenuItems(): HTMLButtonElement[] {
    return [...(optionsMenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
  }

  function onOptionsMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = enabledOptionsMenuItems();
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      closeOptions(true);
      return;
    } else if (event.key === "Tab") {
      event.preventDefault();
      const target = event.shiftKey
        ? composerRef.current?.querySelector<HTMLElement>(".composer-options-trigger")
        : textareaRef.current;
      closeOptions(false);
      queueMicrotask(() => target?.focus({ preventScroll: true }));
      return;
    } else return;
    event.preventDefault();
    const item = items[next];
    setOptionsMenuIndex(Number(item.dataset.menuIndex ?? 0));
    item.focus();
  }

  useEffect(() => {
    if (!optionsOpen) return;
    if (focusOptionsOnOpenRef.current) {
      focusOptionsOnOpenRef.current = false;
      const first = enabledOptionsMenuItems()[0];
      first?.focus({ preventScroll: true });
      setOptionsMenuIndex(Number(first?.dataset.menuIndex ?? 0));
    }
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (optionsMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".composer-options-control")) return;
      closeOptions(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [optionsOpen]);

  return {
    optionsOpen,
    optionsMenuIndex,
    setOptionsMenuIndex,
    optionsMenuRef,
    closeOptions,
    toggleOptions,
    onOptionsMenuKeyDown,
  };
}
