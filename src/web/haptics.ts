/**
 * The half of this app's haptics that iOS cannot do.
 *
 * Safari has no Vibration API, and gives haptics only for a real toggle of a
 * native switch — which is what `SwitchHapticButton` lays over each control.
 * Android has no such gesture but does implement `navigator.vibrate`, so it
 * gets a short pulse of the motor instead. Neither platform has both, so
 * calling this from the same handlers that own the switch cannot double-fire.
 *
 * It is a motor, not a Taptic Engine: long enough to notice is already long
 * enough to annoy, and the feel varies a lot between devices. Ten milliseconds
 * reads as a tick on the phones that do it well and as nothing much on the
 * ones that do not, which is the better failure of the two.
 */
const TAP_MILLISECONDS = 10;

/**
 * Must be called synchronously inside the gesture it belongs to. `vibrate`
 * needs transient user activation, the same rule the clipboard write in
 * MessageActions works around, so nothing may be awaited in front of it.
 */
export function vibrateTap(enabled: boolean): void {
  if (!enabled) return;
  try {
    // Absent on iOS and on desktop Safari; present and inert on a device with
    // no motor. Both are fine — this is the optional half.
    navigator.vibrate?.(TAP_MILLISECONDS);
  } catch {
    // Some engines throw rather than returning false when vibration is
    // disallowed (a hidden document, a user or policy setting). A tap that
    // cannot be felt is not a reason for one that cannot be made.
  }
}
