const CACHE_NAME = "strumm-shell-v9";
const SHELL_ASSETS = [
  "/",
  "/login",
  "/offline",
  "/downloads",
  "/strumm-icon.png",
  "/strumm-logo.png",
  "/manifest.webmanifest",
];

const OFFLINE_URL = "/offline";
const OFFLINE_MEDIA_URL = "/downloads";

const EXCLUDED_PATTERNS = [
  /\.(mp3|m4a|wav|mp4|webm|ogg|aac)$/i,
  /\/api\/stream/i,
  /\/stream/i,
  /\/episodes\/media/i,
  /\/image-proxy/i,
  /googlevideo\.com/i,
  /ytimg\.com/i,
  /youtube\.com/i,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
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

  if (url.pathname.startsWith("/proxy/") || url.pathname.startsWith("/api/")) {
    return;
  }

  const isRscFlight =
    url.searchParams.has("_rsc") ||
    url.searchParams.has("flight") ||
    request.headers.get("rsc") === "1" ||
    (request.headers.get("accept") || "").includes("text/x-component");

  if (isRscFlight) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cachedPage = await caches.match(request, { ignoreSearch: true });
        if (cachedPage) return cachedPage;

        const downloadsPage = await caches.match(OFFLINE_MEDIA_URL);
        if (downloadsPage) return downloadsPage;

        const offlinePage = await caches.match(OFFLINE_URL);
        if (offlinePage) return offlinePage;

        return new Response("You are offline. Reconnect to the internet and try again.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }),
    );
    return;
  }

  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(url.href))) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok && url.origin === self.location.origin) {
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(request, copy))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() => {
          if (request.headers.get("accept")?.includes("text/html")) {
            return caches.match(OFFLINE_URL);
          }
          return new Response(null, { status: 204, statusText: "No Content" });
        });
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
