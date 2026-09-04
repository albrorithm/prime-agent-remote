import * as api from "./api";

/**
 * What the Notifications control should render. Every one of these is a real
 * state a phone can be in, and each needs different words — offering "turn on"
 * to someone who has already denied permission sends them round a loop the
 * page cannot break, because a denied prompt can never be shown again.
 */
export type PushState =
  | "unsupported"
  | "unconfigured"
  | "denied"
  | "off"
  | "on";

export function pushSupported(): boolean {
  try {
    return typeof Notification !== "undefined"
      && typeof navigator !== "undefined"
      && "serviceWorker" in navigator
      // Checked by value, not `in`: a browser without push has no binding at
      // all, so the two agree there, and the value form is what a test can
      // actually take away.
      && typeof window.PushManager !== "undefined";
  } catch {
    return false;
  }
}

export function pushPermission(): NotificationPermission {
  try {
    return Notification.permission;
  } catch {
    return "default";
  }
}

/**
 * `applicationServerKey` takes raw bytes, not the base64url the gateway
 * publishes. Safari in particular rejects the string form outright.
 */
export function decodeApplicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.getRegistration() ?? null;
  } catch {
    return null;
  }
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  const worker = await registration();
  if (!worker) return null;
  try {
    return await worker.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function requestBody(subscription: PushSubscription): api.PushSubscriptionBody | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/**
 * Must be called from a user gesture: `requestPermission` outside one is
 * either ignored or auto-denied, and a denial is permanent as far as this page
 * is concerned.
 */
export async function enablePush(applicationServerKey: string, csrfToken: string, turnEnd: boolean): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  /* Checked before the prompt, not after. `serviceWorker.ready` never rejects —
     with nothing registered it simply never settles, so asking first spent the
     permission prompt (which cannot be shown twice) and then hung the control
     forever with no error to explain it. The service worker registers in
     production builds only, so the Vite dev server hits this every time. */
  if (!await registration()) {
    throw new Error("This page has no service worker, so it cannot receive notifications. Notifications need a production build.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const worker = await navigator.serviceWorker.ready;
  const key = decodeApplicationServerKey(applicationServerKey);
  let subscription = await worker.pushManager.getSubscription();
  if (subscription) {
    // An existing subscription is bound to whichever key created it. If the
    // operator rotated VAPID keys, keeping it would mean a subscription the
    // gateway can no longer encrypt for, which fails silently forever.
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  const body = requestBody(subscription);
  if (!body) {
    await subscription.unsubscribe().catch(() => {});
    throw new Error("The browser returned an incomplete push subscription");
  }
  try {
    await api.subscribeToPush(csrfToken, body, turnEnd);
  } catch (error) {
    // Do not leave the browser holding a subscription the gateway never
    // recorded: it would keep the permission with nothing behind it.
    await subscription.unsubscribe().catch(() => {});
    throw error;
  }
  return "on";
}

/** Tells the gateway to forget the device, then drops the browser's own subscription. */
export async function disablePush(csrfToken: string): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await api.unsubscribeFromPush(csrfToken, subscription.endpoint);
  await subscription.unsubscribe().catch(() => {});
}

/**
 * The sign-out half of revocation. Deliberately makes no gateway call: the
 * logout route drops every record bound to the session, and this runs before
 * that request so the browser stops holding a wake capability either way.
 */
export async function revokePushLocally(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await subscription.unsubscribe().catch(() => {});
}

/**
 * Re-registers an existing subscription under the current session.
 *
 * Records are bound to the session that created them, and sign-out revokes by
 * session id. Without this, a device that subscribed under a session which has
 * since expired would survive the sign-out of the session the user is actually
 * holding, and server-side revocation would quietly leak. Asks for nothing —
 * it runs only when permission is already granted and a subscription already
 * exists — so it is safe on every launch.
 */
export async function reclaimPushSubscription(
  available: { enabled: boolean } | null,
  csrfToken: string,
  turnEnd: boolean,
): Promise<void> {
  if (!available?.enabled || !csrfToken || pushPermission() !== "granted") return;
  const subscription = await currentPushSubscription();
  const body = subscription && requestBody(subscription);
  if (!body) return;
  await api.subscribeToPush(csrfToken, body, turnEnd);
}

/**
 * Changes the turn-end preference on the subscription this device already has.
 *
 * Deliberately not `enablePush`. That unsubscribes and re-mints, which is right
 * when turning notifications on — an existing subscription may be bound to a
 * VAPID key the operator has since rotated — and wrong for a preference flip,
 * which has no reason to pay for it. Two ways it went wrong: a re-subscribe
 * that failed or was throttled left the device with no subscription at all, so
 * changing what you are notified *about* lost notifications entirely; and each
 * flip appended a fresh endpoint and orphaned the old one, so enough toggling
 * pushed other phones' records past the store's bound and silently stopped
 * waking them.
 *
 * Asks for no permission: the toggle only renders once notifications are on.
 */
export async function updatePushPreference(csrfToken: string, turnEnd: boolean): Promise<PushState> {
  const subscription = await currentPushSubscription();
  const body = subscription && requestBody(subscription);
  if (!body) return "off";
  await api.subscribeToPush(csrfToken, body, turnEnd);
  return "on";
}

/**
 * Resolves the control's state without asking for anything, so the panel can
 * render honestly on open.
 */
export async function readPushState(available: { enabled: boolean } | null): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!available?.enabled) return "unconfigured";
  if (pushPermission() === "denied") return "denied";
  return await currentPushSubscription() ? "on" : "off";
}
