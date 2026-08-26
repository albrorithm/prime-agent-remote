import { Check, Copy, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SwitchHapticButton } from "./SwitchHapticButton";

/** Web Share is present in iOS standalone PWAs but absent in jsdom and older desktops. */
export function shareSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * The per-message action row, rendered under the message body.
 *
 * Deliberately NOT a long press. iOS long press already belongs to native text
 * selection (Select / Copy / Look Up / Translate), and in a standalone PWA that
 * callout is the only way to copy part of a message, so overriding it is a net
 * loss. A JS long press also cannot fire this app's switch-based haptic, which
 * needs a real toggle from the user's own touch, so it would open silently.
 * A visible row costs nothing, works with VoiceOver and a keyboard, and is
 * where people look for these controls anyway.
 */
export function MessageActions({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  function copy() {
    // Safari only honours a clipboard write inside the gesture that requested
    // it, so the write starts here with nothing awaited in front of it.
    const written = navigator.clipboard?.writeText(text);
    if (!written) return;
    void written.then(
      () => {
        setCopied(true);
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), 1600);
      },
      () => {
        // Clipboard access can be denied; the text stays selectable.
      },
    );
  }

  function share() {
    void navigator.share?.({ text }).catch(() => {
      // The user dismissed the sheet, or sharing is unavailable.
    });
  }

  if (!text) return null;

  return (
    <div className="message-actions" role="group" aria-label={`${label} message actions`} data-gesture-exclusion>
      <SwitchHapticButton
        buttonClassName="message-action"
        label={copied ? "Copied" : "Copy message"}
        onActivate={copy}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </SwitchHapticButton>
      {shareSupported() && (
        <SwitchHapticButton buttonClassName="message-action" label="Share message" onActivate={share}>
          <Share2 aria-hidden="true" />
        </SwitchHapticButton>
      )}
      <span className="sr-only" role="status" aria-live="polite">{copied ? "Copied" : ""}</span>
    </div>
  );
}
