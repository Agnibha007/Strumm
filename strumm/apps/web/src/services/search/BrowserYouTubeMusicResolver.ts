/**
 * BrowserYouTubeMusicResolver — resolves importer search candidates from the
 * user's BROWSER using keyless public Piped instances (no API key / quota).
 *
 * Why not youtubei.js' InnerTube?
 * -------------------------------
 * Originally this resolved via youtubei.js' InnerTube client in YT Music mode
 * running in the browser. youtubei.js however always initializes through two
 * cross-origin requests — ``www.youtube.com/youtubei/v1/config`` and
 * ``www.youtube.com/iframe_api`` — and YouTube no longer sends the CORS
 * headers third-party origins need (the config endpoint returns 403 with no
 * ``Access-Control-Allow-Origin``, and ``/iframe_api`` returns 200 without
 * one), so the InnerTube session can never initialize from an app origin.
 * Piped instances answer every origin (``access-control-allow-origin: *``)
 * and perform the YouTube request themselves, so they work in the browser on
 * any network and never need a key.
 *
 * This uses the exact same provider as the web search box
 * (``invidiousProvider``) and emits the same candidate contract as the backend
 * importer's raw provider output, so the Python ``_rank_candidates`` /
 * ``_build_song_item`` matcher consumes it unchanged.
 *
 *   { videoId, title, artists: [{ name }], artist, duration ("m:ss"),
 *     duration_seconds, thumbnails: [{ url }] }
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { invidiousProvider } from "web/services/search/InvidiousProvider";
import type { SongResult } from "web/services/search/SearchProvider";

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
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Piped ``SongResult`` (as produced by ``invidiousProvider``) into
 * the importer-shaped candidate. Invalid video ids / empty titles are skipped.
 */
export function songResultToCandidate(song: SongResult): BrowserMusicCandidate | null {
  if (!song || !/^[a-zA-Z0-9_-]{11}$/.test(song.videoId || "")) return null;
  const title = (song.title || "").trim();
  if (!title) return null;
  const artist = (song.artist || "").trim();
  const durationSeconds = Math.max(0, Math.floor(song.duration || 0));
  return {
    videoId: song.videoId,
    title,
    artists: artist ? [{ name: artist }] : [],
    artist: artist || "Unknown Artist",
    duration: secondsToMmss(durationSeconds),
    duration_seconds: durationSeconds,
    thumbnails: song.thumbnail ? [{ url: song.thumbnail }] : [],
  };
}

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
 * Resolve a single track query to importer search candidates from the
 * browser via the keyless Piped instances. Returns an empty candidate array
 * on any failure (caller falls back to the server-side chain).
 */
export async function resolveTrackOnBrowser(query: string, limit = 10): Promise<BrowserMusicCandidate[]> {
  if (!query || !query.trim()) return [];

  try {
    const results = await invidiousProvider.search(query, "video");
    return results.songs
      .map(songResultToCandidate)
      .filter((c): c is BrowserMusicCandidate => c !== null)
      .slice(0, limit);
  } catch (err) {
    console.warn(`BrowserYouTubeMusicResolver: search failed for query "${query}":`, err);
    return [];
  }
}

/**
 * Resolve many tracks' queries sequentially with a small concurrency cap to
 * avoid hammering the Piped instances. Returns a map of query -> candidates.
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