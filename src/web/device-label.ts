/**
 * What to call this browser in the paired-device list.
 *
 * The pairing request has carried an optional `deviceName` since devices
 * existed, and nothing ever sent one — so `AuthService` fell back to the
 * literal string "device" and every record got the same name. That did not
 * matter while nobody could see the list. It does now: a device list where
 * every row reads "device" answers none of the question it exists for.
 *
 * Asking the user to type a name is the obvious alternative and the wrong one.
 * Pairing already asks for a long token on a phone keyboard, and a name is
 * something a person will skip and then wish they had. A guess from the user
 * agent is right often enough to be useful and is never worse than "device".
 *
 * Two phones of the same kind both read "iPhone". `createdAt` and `lastSeenAt`
 * are what separate them in the list, which is the same way anyone actually
 * identifies a device they are trying to revoke — "the one I stopped using in
 * March", not its name.
 */

/** Longest first: "iPad" must be tested before "Mac", which iPadOS also claims. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/i, "iPhone"],
  [/\biPad\b/i, "iPad"],
  [/\biPod\b/i, "iPod"],
  [/\bAndroid\b/i, "Android"],
  [/\bCrOS\b/i, "Chromebook"],
  [/\bMac OS X\b|\bMacintosh\b/i, "Mac"],
  [/\bWindows\b/i, "Windows PC"],
  [/\bLinux\b/i, "Linux"],
];

const MAX_DEVICE_LABEL_CHARS = 64;

export function deviceLabel(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  /* Desktop Safari on an iPad reports a Macintosh user agent and is only
     distinguishable by having touch points, which is the one case worth the
     extra check — an iPad filed as "Mac" is a device its owner will not
     recognise. */
  const iPadPretendingToBeAMac = /\bMacintosh\b/i.test(userAgent)
    && typeof navigator !== "undefined"
    && (navigator.maxTouchPoints ?? 0) > 1;
  if (iPadPretendingToBeAMac) return "iPad";

  for (const [pattern, label] of PATTERNS) {
    if (pattern.test(userAgent)) return label;
  }
  // The schema bounds this at 64; "device" is what the server would have used.
  return "Device";
}

export { MAX_DEVICE_LABEL_CHARS };
