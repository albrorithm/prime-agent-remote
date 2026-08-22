import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

interface SwitchHapticButtonProps {
  ariaControls?: string;
  ariaExpanded?: boolean;
  buttonClassName?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
  onActivate: (source?: "button" | "switch") => void;
  preserveFocus?: boolean;
}

/**
 * Keeps an accessible button beside a directly tappable Safari switch. The
 * transparent native switch receives touch input, while keyboard and
 * assistive-technology activation continue to use the real button.
 */
export function SwitchHapticButton({
  ariaControls,
  ariaExpanded,
  buttonClassName,
  children,
  className,
  disabled = false,
  label,
  onActivate,
  preserveFocus = false,
}: SwitchHapticButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const preservedFocusRef = useRef<HTMLElement | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!preserveFocus) return;
    preservedFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    event.preventDefault();
  }

  function restorePreservedFocus() {
    const target = preservedFocusRef.current;
    preservedFocusRef.current = null;
    target?.focus({ preventScroll: true });
  }

  function handleButtonClick() {
    onActivate("button");
    if (preserveFocus) restorePreservedFocus();
  }

  function handleSwitchClick() {
    if (!preserveFocus) buttonRef.current?.focus({ preventScroll: true });
    onActivate("switch");
    if (preserveFocus) restorePreservedFocus();
  }

  return (
    <span className={["switch-haptic-button", className].filter(Boolean).join(" ")}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClassName}
        aria-label={label}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerCancel={() => { preservedFocusRef.current = null; }}
        onClick={handleButtonClick}
      >
        {children}
      </button>
      <input
        className="switch-haptic-input"
        type="checkbox"
        {...{ switch: "" }}
        aria-hidden="true"
        tabIndex={-1}
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerCancel={() => { preservedFocusRef.current = null; }}
        onClick={handleSwitchClick}
      />
    </span>
  );
}
