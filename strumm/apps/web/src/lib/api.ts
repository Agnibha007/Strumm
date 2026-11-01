// Absolute origin of the backend API. Used only for connections that need a
// real origin at runtime (WebSocket). All HTTP traffic goes through the
// same-origin /proxy rewrite in next.config.ts so the browser never does
// cross-origin calls (the HF Spaces gateway does not send
// Access-Control-Allow-Credentials, which broke every cookie-authenticated
// request).
export const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/+$/, "");

// Kept for back-compat; points at the same origin as API_ORIGIN.
export const API_BASE_URL = API_ORIGIN;

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Relative, same-origin: routed by the /proxy rewrite in next.config.ts.
  return `/proxy${normalizedPath}`;
}

export function cleanUsername(value: string) {
  return cleanText(value, 30).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

export function decodeHtml(html: string): string {
  if (!html) return "";
  // Decode iteratively to handle double-encoded entities (e.g. &amp;amp; -> &)
  let prev: string;
  let result = html;
  do {
    prev = result;
    result = result
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'");
  } while (result !== prev);
  return result;
}

export function stripHtml(html: string): string {
  if (!html) return "";
  const decoded = decodeHtml(html);
  return decoded.replace(/<[^>]*>/g, "");
}

export function cleanText(value: string, maxLength = 500) {
  return decodeHtml(value).replace(/\0/g, "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Prefetching — pre-warm pages and songs the user is most likely to visit.
// ---------------------------------------------------------------------------

// Top-N most-visited song pages to prefetch on next idle/load.
const MAX_PREFETCH_SONGS = 8;

// Kept in localStorage so it survives navigation and survives a full page
// reload. A page reload never empties it — otherwise the user's history would
// be lost on every visit and the cache would lose its value.
export const PREFETCH_STORAGE_KEY = "strumm:prefetch:history" as const;

export type PrefetchEntry = {
  id: string;
  timestamp: number;
};

export type PrefetchHistory = PrefetchEntry[];

/** Read the stored prefetch history, or a default empty array when nothing exists yet. */
export function readPrefetchHistory(): PrefetchEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PREFETCH_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PrefetchEntry[];
    return [];
  } catch {
    return [];
  }
}

/** Append a new visit for a song page and trim to the most recent ``limit`` entries. */
export function recordPrefetch(id: string, limit = 200): void {
  if (typeof window === "undefined") return;
  try {
    const history = readPrefetchHistory();
    const now = Date.now();
    // De-duplicate: if the entry already exists, move it to the end (most recent).
    const existing = history.findIndex((h) => h.id === id);
    if (existing >= 0) {
      history.splice(existing, 1);
    }
    history.push({ id, timestamp: now });
    // Keep the list bounded so it never grows without limit across thousands of visits.
    if (history.length > limit) {
      history.splice(0, history.length - limit);
    }
    window.localStorage.setItem(PREFETCH_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage unavailable (private mode / quota) — ignore, path and store still work.
  }
}

/** Return the most-visited song IDs, ordered newest first, truncated to ``limit``. */
export function mostVisitedSongs(limit = MAX_PREFETCH_SONGS): string[] {
  const history = readPrefetchHistory();
  // Deduplicate while preserving newest-first order.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of history) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    ordered.push(entry.id);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

/** Prefetch the metadata (via the backend /resolve endpoint) for each id. */
export async function prefetchSongMetadata(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const base = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
  // Run all resolves in parallel so the whole batch resolves quickly instead of
  // serially. Each call is guarded against throwing so one failed request does
  // not cancel the rest.
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(
          `${base}/resolve/${encodeURIComponent(id)}`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (!res.ok) return;
        // Ignore the payload — we only need the HTTP round-trip to warm the
        // backend's cache and bring the asset into the client's HTTP cache.
      } catch {
        // Network or timeout — ignore, the next navigation will retry.
      }
    }),
  );
}
