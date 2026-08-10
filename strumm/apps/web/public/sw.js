const CACHE_NAME = "strumm-shell-v7";
const SHELL_ASSETS = [
  "/",
  "/login",
  "/offline",
  "/strumm-icon.png",
  "/strumm-logo.png",
  "/manifest.webmanifest",
];

const OFFLINE_URL = "/offline";

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
  /youtube\.com/i,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isExcluded = EXCLUDED_PATTERNS.some((pattern) => pattern.test(url.href));

  if (isExcluded) {
    return;
  }

  // Never intercept Next.js RSC (flight) fetches: client-side navigation must
  // always hit the network so the router receives a live payload. Serving a
  // stale cached flight response makes the router error and fall back to a
  // full page reload on every nav click.
  const isRscFlight =
    url.searchParams.has("_rsc") ||
    url.searchParams.has("flight") ||
    request.headers.get("rsc") === "1" ||
    (request.headers.get("accept") || "").includes("text/x-component");
  if (isRscFlight) {
    return;
  }

  // Never intercept API traffic (the browser reaches the backend via /proxy);
  // API responses are live data and must not be served from cache.
  if (url.pathname.startsWith("/proxy/")) {
    return;
  }

  // Network-only for navigation requests (never cache HTML — prevents stale RSC payload errors)
  // Falls back to the offline page when the network is unavailable.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) =>
          cached || caches.match(OFFLINE_URL)
        )
      ),
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            if (!url.pathname.startsWith("/api/")) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
          }
          return response;
        })
        .catch(() => {
          if (request.headers.get("accept")?.includes("text/html")) {
            return caches.match(OFFLINE_URL);
          }
          return new Response("", { status: 503, statusText: "Offline" });
        });
    }),
  );
});

// Listen for update messages from the client
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
