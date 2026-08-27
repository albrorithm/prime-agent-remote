import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { vibrateTap } from "../haptics";
import { useHapticsEnabled } from "../settings";

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
 *
 * Both halves answer to the haptics setting. Turning it off has to remove the
 * switch, not merely ignore it: the feedback comes from iOS toggling a real
 * native control, so there is nothing to suppress after the fact. The setting
 * is read through `useHapticsEnabled` rather than `useSettings` because these
 * buttons live inside rows that several tests render without a provider, and a
 * control should not refuse to exist over a preference it can default.
 *
 * The switch is also dropped for fine pointers in styles.css — a mouse has
 * nothing to feel and the overlay was eating `:hover` on the button beneath.
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
  const haptics = useHapticsEnabled();

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
    // Both paths, not just the switch: on Android the overlay takes the tap,
    // but a keyboard activation and any pointer that skipped the overlay
    // arrive here. Synchronously, before anything else — `vibrate` needs the
    // user activation this handler is still inside.
    vibrateTap(haptics);
    onActivate("button");
    if (preserveFocus) restorePreservedFocus();
  }

  function handleSwitchClick() {
    vibrateTap(haptics);
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
      {haptics && (
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
      )}
    </span>
  );
}
