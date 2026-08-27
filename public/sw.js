const CACHE_PREFIX = "prime-agent-shell-";
// Rewritten by scripts/hash-sw.mjs (a postbuild step) with a hash of the
// built shell, so the cache name always changes when the shell does. This
// "dev" fallback is only ever seen when sw.js is served unbuilt from public/.
const BUILD_ID = "dev";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const STATIC_SHELL = [
  "/manifest.webmanifest",
  // Also discoverable from index.html, but listed explicitly: if it is ever
  // missing offline the app paints the wrong theme before the bundle loads.
  "/theme-init.js",
  "/prime-mark.svg",
  "/prime-mark-180.png",
  "/prime-mark-192.png",
  "/prime-mark-512.png",
];

function isCacheableShellUrl(value) {
  const url = new URL(value, self.location.origin);
  return url.origin === self.location.origin
    && !url.pathname.startsWith("/api/")
    && !url.pathname.startsWith("/ws");
}

async function precacheBuiltShell() {
  const cache = await caches.open(CACHE_NAME);
  // Vite fingerprints the production JS and CSS, so their names are not known
  // when this public file is authored. Discover them from the built index.
  const indexResponse = await fetch(new Request("/", { cache: "reload" }));
  if (!indexResponse.ok) throw new Error("Could not cache the app shell");
  const html = await indexResponse.clone().text();
  await cache.put("/", indexResponse);
  const builtAssets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter(isCacheableShellUrl);
  await cache.addAll([...new Set([...STATIC_SHELL, ...builtAssets])]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheBuiltShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin
    || event.request.method !== "GET"
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/ws")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

const NOTIFICATION_FALLBACK_TITLE = "Prime Agent";
const NOTIFICATION_FALLBACK_BODY = "A session needs your attention";

function readPushPayload(event) {
  try {
    const value = event.data ? event.data.json() : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    // A payload this worker cannot read still has to produce a notification:
    // browsers revoke the push subscription of a worker that stays silent.
    return null;
  }
}

function boundedText(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

// The worker sets the badge itself rather than leaving it to the app. A badge
// only written by the running app goes stale exactly when it matters, which is
// while the app is closed — the state this notification just interrupted.
async function applyBadge(count) {
  const badging = self.navigator;
  if (!badging) return;
  try {
    if (count > 0) await badging.setAppBadge?.(count);
    else await (badging.clearAppBadge?.() ?? badging.setAppBadge?.(0));
  } catch {
    // iOS resolves this into nothing until notification permission is granted.
  }
}

async function showAttention(payload) {
  const badge = Number.isSafeInteger(payload?.badge) && payload.badge > 0 ? payload.badge : 0;
  await applyBadge(badge);
  const agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
  await self.registration.showNotification(boundedText(payload?.title, NOTIFICATION_FALLBACK_TITLE), {
    body: boundedText(payload?.body, NOTIFICATION_FALLBACK_BODY),
    icon: "/prime-mark-192.png",
    badge: "/prime-mark-192.png",
    /* One notification per session PER KIND. A second request from the same
       agent replaces the first rather than stacking up — but a finished turn
       must never replace a banner asking for an answer, which is the more
       urgent of the two and the one that would be silently lost. */
    tag: `${typeof payload?.kind === "string" ? payload.kind : "attention"}:${agentId ?? ""}`,
    renotify: true,
    data: { agentId },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(showAttention(readPushPayload(event)));
});

async function openApp(agentId) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => client.url.startsWith(self.location.origin));
  // Focus rather than open a second window: the app the user already has is
  // holding a connected socket and a scrolled transcript.
  if (existing) return existing.focus();
  return self.clients.openWindow(agentId ? `/?agent=${encodeURIComponent(agentId)}` : "/");
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp(event.notification.data ? event.notification.data.agentId : null));
});
