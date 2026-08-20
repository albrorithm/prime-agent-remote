const CACHE_NAME = "prime-agent-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/prime-mark.svg", "/prime-mark-192.png", "/prime-mark-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
