import { act, renderHook } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useOptionsMenu } from "./useOptionsMenu";

function setup(id = "agent-1") {
  return renderHook(
    ({ id }: { id: string }) => {
      const composerRef = useRef<HTMLDivElement>(null);
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      return { menu: useOptionsMenu(id, composerRef, textareaRef), composerRef, textareaRef };
    },
    { initialProps: { id } },
  );
}

/** Builds a composer container with a trigger button, wires it and a menu with `count` items (some disabled) into the hook's refs. */
function wireComposer(result: ReturnType<typeof setup>["result"], itemCount = 3, disabledIndexes: number[] = []) {
  const composer = document.createElement("div");
  const trigger = document.createElement("button");
  trigger.className = "composer-options-trigger";
  composer.appendChild(trigger);
  document.body.appendChild(composer);
  result.current.composerRef.current = composer;

  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  result.current.textareaRef.current = textarea;

  const menuEl = document.createElement("div");
  document.body.appendChild(menuEl);
  const items: HTMLButtonElement[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    item.dataset.menuIndex = String(index);
    if (disabledIndexes.includes(index)) item.disabled = true;
    menuEl.appendChild(item);
    items.push(item);
  }
  result.current.menu.optionsMenuRef.current = menuEl;

  return { composer, trigger, textarea, menuEl, items };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("useOptionsMenu", () => {
  it("starts closed with menu index 0", () => {
    const { result } = setup();
    expect(result.current.menu.optionsOpen).toBe(false);
    expect(result.current.menu.optionsMenuIndex).toBe(0);
  });

  it("opens on toggle and closes on a second toggle", () => {
    const { result } = setup();
    wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    expect(result.current.menu.optionsOpen).toBe(true);
    act(() => result.current.menu.toggleOptions("button"));
    expect(result.current.menu.optionsOpen).toBe(false);
  });

  it("restores focus to the trigger when opened from the button and closed with restoreFocus", async () => {
    const { result } = setup();
    const { trigger } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    act(() => result.current.menu.closeOptions(true));
    await flushMicrotasks();
    expect(trigger).toHaveFocus();
  });

  it("restores focus to whatever was previously focused when opened via the switch", async () => {
    const { result } = setup();
    wireComposer(result);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    act(() => result.current.menu.toggleOptions("switch"));
    act(() => result.current.menu.closeOptions(true));
    await flushMicrotasks();
    expect(outside).toHaveFocus();
  });

  it("does not move focus when closeOptions is called without restoreFocus", async () => {
    const { result } = setup();
    const { trigger } = wireComposer(result);
    trigger.focus();
    act(() => result.current.menu.toggleOptions("button"));
    act(() => result.current.menu.closeOptions(false));
    await flushMicrotasks();
    expect(trigger).not.toHaveFocus();
  });

  it("focuses the first enabled item when opened from the button trigger", () => {
    const { result } = setup();
    const { items } = wireComposer(result, 3, [0]);
    act(() => result.current.menu.toggleOptions("button"));
    expect(items[1]).toHaveFocus();
    expect(result.current.menu.optionsMenuIndex).toBe(1);
  });

  it("does not steal focus when opened from the switch", () => {
    const { result } = setup();
    const { items } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("switch"));
    expect(items[0]).not.toHaveFocus();
  });

  it("cycles focus through enabled menu items with ArrowDown/ArrowUp, skipping disabled ones", () => {
    const { result } = setup();
    const { items } = wireComposer(result, 3, [1]);
    act(() => result.current.menu.toggleOptions("switch"));
    items[0].focus();

    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "ArrowDown", preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    expect(items[2]).toHaveFocus();
    expect(result.current.menu.optionsMenuIndex).toBe(2);

    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "ArrowUp", preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    expect(items[0]).toHaveFocus();
  });

  it("Home and End jump to the first and last item", () => {
    const { result } = setup();
    const { items } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("switch"));
    items[1].focus();

    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "End", preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    expect(items[2]).toHaveFocus();

    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "Home", preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    expect(items[0]).toHaveFocus();
  });

  it("Escape closes the menu and restores focus", async () => {
    const { result } = setup();
    const { trigger } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "Escape", preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    expect(result.current.menu.optionsOpen).toBe(false);
    await flushMicrotasks();
    expect(trigger).toHaveFocus();
  });

  it("Tab closes the menu and moves focus to the textarea without restoring the trigger", async () => {
    const { result } = setup();
    const { textarea } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "Tab", shiftKey: false, preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    expect(result.current.menu.optionsOpen).toBe(false);
    await flushMicrotasks();
    expect(textarea).toHaveFocus();
  });

  it("Shift+Tab closes the menu and moves focus back to the trigger", async () => {
    const { result } = setup();
    const { trigger } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    act(() => result.current.menu.onOptionsMenuKeyDown({
      key: "Tab", shiftKey: true, preventDefault: () => {},
    } as unknown as Parameters<typeof result.current.menu.onOptionsMenuKeyDown>[0]));
    await flushMicrotasks();
    expect(trigger).toHaveFocus();
  });

  it("resets open state and menu index when the agent id changes", () => {
    const { result, rerender } = setup("agent-1");
    wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    expect(result.current.menu.optionsOpen).toBe(true);

    rerender({ id: "agent-2" });
    expect(result.current.menu.optionsOpen).toBe(false);
    expect(result.current.menu.optionsMenuIndex).toBe(0);
  });

  it("closes without restoring focus when a pointer goes down outside the menu and trigger", () => {
    const { result } = setup();
    const { trigger } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    act(() => {
      fireEvent.pointerDown(outside);
    });
    expect(result.current.menu.optionsOpen).toBe(false);
    expect(trigger).not.toHaveFocus();
  });

  it("stays open when a pointer goes down inside the menu itself", () => {
    const { result } = setup();
    const { menuEl } = wireComposer(result);
    act(() => result.current.menu.toggleOptions("button"));

    act(() => {
      fireEvent.pointerDown(menuEl);
    });
    expect(result.current.menu.optionsOpen).toBe(true);
  });

  it("stays open when a pointer goes down on the trigger control", () => {
    const { result } = setup();
    const { composer } = wireComposer(result);
    composer.classList.add("composer-options-control");
    act(() => result.current.menu.toggleOptions("button"));

    act(() => {
      fireEvent.pointerDown(composer);
    });
    expect(result.current.menu.optionsOpen).toBe(true);
  });
});
