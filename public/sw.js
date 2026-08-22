const CACHE_PREFIX = "prime-agent-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v4`;
const STATIC_SHELL = [
  "/manifest.webmanifest",
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
