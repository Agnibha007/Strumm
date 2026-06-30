const CACHE_NAME = "strumm-shell-v3";
const SHELL_ASSETS = ["/", "/login", "/strumm-icon.png", "/strumm-logo.png", "/manifest.webmanifest"];

// Exclude copyrighted media, dynamic stream endpoints, and image proxies from SW cache
const EXCLUDED_PATTERNS = [
  /\.(mp3|m4a|wav|mp4|webm|ogg|aac)$/i,
  /\/api\/stream/i,
  /\/stream/i,
  /\/podcast/i,
  /\/episodes\/media/i,
  /\/image-proxy/i,
  /googlevideo\.com/i,
  /ytimg\.com/i,
  /youtube\.com/i
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = request.url;
  const isExcluded = EXCLUDED_PATTERNS.some(pattern => pattern.test(url));

  if (isExcluded) {
    // Pass-through without caching
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        if (response.ok && new URL(request.url).origin === self.location.origin) {
          // Do not cache API json data - keep it fresh
          if (!url.includes("/api/")) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
        }
        return response;
      })
      .catch(() => {
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          if (
            request.mode === "navigate" ||
            (request.headers.get("accept") && request.headers.get("accept").includes("text/html"))
          ) {
            return caches.match("/");
          }
          return null;
        });
      }),
  );
});
