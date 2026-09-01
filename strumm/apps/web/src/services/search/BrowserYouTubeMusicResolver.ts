/**
 * BrowserYouTubeMusicResolver — resolves YouTube Music candidates from the
 * user's BROWSER, on their residential IP.
 *
 * Why this exists
 * ---------------
 * The backend (Hugging Face Spaces / cloud egress) is IP-blocked by YouTube's
 * CDN, so server-side ytmusicapi lookups fail. The user's browser is not
 * blocked, so youtubei.js' InnerTube client — in YT_MUSIC mode — can resolve
 * real YouTube Music results client-side.
 *
 * Imports
 * -------
 * Uses the browser build of youtubei.js (`youtubei.js/web`) so it can run in
 * the client bundle without Node-only shims. The module is marked client-only
 * and must only be imported from `"use client"` code paths.
 *
 * Output shape
 * ------------
 * Each candidate is shaped EXACTLY like the backend importer's raw provider
 * output so the Python `_rank_candidates` matcher consumes it unchanged:
 *
 *   { videoId, title, artists: [{ name }], artist, duration ("m:ss"),
 *     duration_seconds, thumbnails: [{ url }] }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserMusicCandidate {
  videoId: string;
  title: string;
  artists: { name: string }[];
  artist: string;
  duration: string; // "m:ss" / "h:mm:ss"
  duration_seconds: number;
  thumbnails: { url: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert seconds to a "m:ss" / "h:mm:ss" string. */
export function secondsToMmss(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Extract a Text-like value (youtubei.js Text or string) to a plain string. */
function toText(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val.toString === "function") {
    try {
      return val.toString();
    } catch {
      /* fall through */
    }
  }
  return String(val);
}

/** Extract the artists array from a MusicResponsiveListItem. */
function extractArtistNames(item: any): { name: string }[] {
  const artists: { name: string }[] = [];
  const raw = item?.artists ?? item?.authors;
  if (Array.isArray(raw)) {
    for (const a of raw) {
      const name = toText(a?.name).trim();
      if (name) artists.push({ name });
    }
  }
  // Some nodes expose a plain author object instead of an array.
  if (artists.length === 0 && item?.author?.name) {
    const name = toText(item.author.name).trim();
    if (name) artists.push({ name });
  }
  return artists;
}

/** Pick the best thumbnail URL from a youtubei.js thumbnail set. */
function pickThumbnail(item: any): string {
  const thumbs = item?.thumbnail?.contents ?? item?.thumbnail;
  if (Array.isArray(thumbs) && thumbs.length > 0) {
    const last = thumbs[thumbs.length - 1];
    const url = last?.url ? toText(last.url) : "";
    if (url) return url;
  }
  const direct = toText(item?.thumbnail?.url ?? "");
  if (direct) return direct;
  return "";
}

/**
 * Convert a MusicResponsiveListItem node (only song/video types) to the
 * importer-shaped candidate. Albums/artists (no videoId) are skipped.
 */
export function musicItemToCandidate(item: any): BrowserMusicCandidate | null {
  try {
    const videoId = toText(item?.id ?? "").trim();
    // Real YouTube video ids are exactly 11 chars (alnum, - or _). Playlist
    // ("PL…"), album ("MPREb…") and radio/mix ids are longer — those are not
    // usable as song candidates.
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
    // Only song/video items are usable for track matching.
    const itemType = item?.item_type ?? item?.type;
    if (itemType && !["song", "video", "endpoint"].includes(itemType)) return null;

    const title = toText(item?.title ?? "").trim();
    if (!title) return null;

    const artists = extractArtistNames(item);
    const artist = artists.map((a) => a.name).join(", ") || "Unknown Artist";

    const duration = item?.duration;
    let durationSeconds = 0;
    if (typeof duration === "object" && duration != null) {
      durationSeconds = Number(duration.seconds) || 0;
    } else if (typeof duration === "number") {
      durationSeconds = duration;
    }

    const thumbnail = pickThumbnail(item);

    return {
      videoId,
      title,
      artists,
      artist,
      duration: secondsToMmss(durationSeconds),
      duration_seconds: durationSeconds,
      thumbnails: thumbnail ? [{ url: thumbnail }] : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lazy Innertube (YT Music) singleton — created once per page load and reused
// ---------------------------------------------------------------------------

let innertubePromise: Promise<any> | null = null;
let innertubeInstance: any = null;
let lastCreatedAt = 0;
const INSTANCE_REFRESH_MS = 15 * 60 * 1000; // refresh every 15 minutes

async function getYtMusicInnertube(): Promise<any> {
  if (typeof window === "undefined") {
    throw new Error("BrowserYouTubeMusicResolver must run in the browser");
  }

  const now = Date.now();
  if (innertubeInstance && now - lastCreatedAt < INSTANCE_REFRESH_MS) {
    return innertubeInstance;
  }
  if (innertubePromise) {
    return innertubePromise;
  }

  innertubePromise = (async () => {
    // Browser build of youtubei.js. Dynamic import avoids pulling the Node
    // build into the server bundle.
    const { Innertube } = await import("youtubei.js/web");
    const instance = await Innertube.create({
      // ClientType.MUSIC = "WEB_REMIX" (the YTMusic InnerTube client). The
      // enum itself isn't re-exported from the "youtubei.js/web" entry point,
      // so the raw enum value is provided.
      client_type: "WEB_REMIX" as any,
      // Local session generation avoids a server-IP round-trip at startup and
      // keeps creation fast in the browser.
      generate_session_locally: true,
    });
    innertubeInstance = instance;
    lastCreatedAt = Date.now();
    return innertubeInstance;
  })().finally(() => {
    innertubePromise = null;
  });

  return innertubePromise;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Walk a parsed YT Music search tree and collect the song candidates.
 *
 * Search.contents is an ObservedArray of shelves — MusicShelf / ItemSection —
 * whose `contents` hold the actual song-list items, so this recurses through
 * nested wrapper nodes and only converts leaf nodes that carry a video id.
 * Duplicates are NOT de-duplicated here (the API matcher handles dedup), and
 * the max result count is enforced.
 */
export function collectSongCandidates(nodes: any[], limit = 10): BrowserMusicCandidate[] {
  const candidates: BrowserMusicCandidate[] = [];

  const walk = (items: any[]) => {
    for (const node of items) {
      if (!node || candidates.length >= limit) continue;
      if (typeof node.id === "string" && node.id) {
        const cand = musicItemToCandidate(node);
        if (cand) candidates.push(cand);
        continue; // leaf node, never descend into it
      }
      // Shelf / section wrapper: descend into its contents array.
      if (Array.isArray(node.contents)) walk(node.contents);
    }
  };

  walk(nodes);
  return candidates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a single track query to YouTube Music candidates from the browser.
 * Returns an empty candidate array on any failure (caller falls back to the
 * server-side chain).
 */
export async function resolveTrackOnBrowser(query: string, limit = 10): Promise<BrowserMusicCandidate[]> {
  if (!query || !query.trim()) return [];

  let yt: any;
  try {
    yt = await getYtMusicInnertube();
  } catch (err) {
    console.warn("BrowserYouTubeMusicResolver: Innertube init failed:", err);
    return [];
  }

  try {
    // YT Music search, filtered to songs. `filters` is the second positional
    // arg (MusicSearchFilters: { type: 'song' }).
    const search = await yt.music.search(query, { type: "song" });
    return collectSongCandidates(search?.contents ?? [], limit);
  } catch (err) {
    console.warn(`BrowserYouTubeMusicResolver: search failed for query "${query}":`, err);
    return [];
  }
}

/**
 * Resolve many tracks' queries sequentially with a small concurrency cap to
 * avoid hammering InnerTube. Returns a map of query -> candidates.
 */
export async function resolveTracksOnBrowser(
  queries: string[],
  options: { limit?: number; concurrency?: number } = {},
): Promise<Record<string, BrowserMusicCandidate[]>> {
  const limit = options.limit ?? 10;
  const concurrency = Math.min(Math.max(options.concurrency ?? 3, 1), 6);
  const out: Record<string, BrowserMusicCandidate[]> = {};

  let head = 0;
  async function worker() {
    while (head < queries.length) {
      const q = queries[head++];
      if (!q) continue;
      out[q] = await resolveTrackOnBrowser(q, limit);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queries.length || 1) }, () => worker());
  await Promise.all(workers);
  return out;
}