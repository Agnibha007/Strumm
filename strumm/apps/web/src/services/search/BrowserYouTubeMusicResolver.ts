/**
 * BrowserYouTubeMusicResolver — resolves importer search candidates through the
 * Strumm backend proxy (same-origin `/proxy/yt/*`). YouTube Music / Piped /
 * yt-dlp fallbacks run SERVER-SIDE; the browser never calls public Piped
 * instances or YouTube directly.
 *
 * This uses the exact same provider surface as the web search box
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
import { fetchPipedStreams } from "web/services/search/InvidiousProvider";
import type { Song } from "@strumm/types";
import type { SongResult } from "web/services/search/SearchProvider";
import {
  cleanTitle,
  extractArtistPrefix,
  inferArtist,
  canonicalString,
  normalizeArtist,
  canonicalArtist,
} from "web/services/metadata";
import { decodeHtml } from "web/lib/api";

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
  /** Canonical dedup key derived from the FINAL title (consistent with search). */
  canonicalTitle?: string;
  /** Canonical dedup key derived from the FINAL artist (consistent with search). */
  canonicalArtist?: string;
}

// ---------------------------------------------------------------------------
// Finalization choke point
// ---------------------------------------------------------------------------
//
// RAW PROVIDER DATA
//         ↓
//   finalizeCandidate()
//         ↓
// CANONICAL Candidate (title / artist / canonicalTitle / canonicalArtist)
//         ↓
//   player queue / persistence / display
//
// Every RAW entry point in this module funnels through here so search, radio,
// related tracks, metadata resolution and music-item conversion share ONE
// normalisation contract (cleanTitle → extractArtistPrefix → inferArtist →
// canonical keys) instead of each path applying its own ad-hoc cleanup.

export interface FinalizeOptions {
  /**
   * Raw uploader / channel name ("SnoopDoggVEVO", "KK - Topic", "Pritam
   * Official", …). Feeds the channel-confidence signals of the normalizer.
   */
  channelTitle?: string;
  /**
   * Authoritative structured artist (e.g. YT Music `artists[]`). When present
   * it is preferred over anything inferred from the title prefix.
   */
  knownArtist?: string;
  /**
   * True when the input has ALREADY passed through `normalizeSong()`
   * (search / playlist SongResults). Re-running the splitter could perform a
   * second, contradictory split, so this path only (re)derives canonical keys
   * and leaves title / artist byte-for-byte untouched (idempotent).
   */
  alreadyNormalized?: boolean;
}

export interface FinalizedSongMetadata {
  title: string;
  artist: string;
  canonicalTitle: string;
  canonicalArtist: string;
}

/**
 * Turn RAW provider metadata into the canonical Song metadata used everywhere
 * else in the app.
 *
 * Idempotence strategy: call sites that consume already-normalized
 * ``SongResult``s (``songResultToCandidate`` → search / playlist results)
 * pass ``alreadyNormalized`` so the cleaning / artist-prefix stages are
 * skipped entirely. Raw call sites (``musicItemToCandidate``,
 * ``resolveMetadataOnBrowser``, ``resolveRelatedOnBrowser``) run the full
 * pipeline exactly once. The pipeline itself is additionally a semantic
 * fixpoint on its own output (a split title no longer contains " - ", so a
 * repeat run is a no-op), which makes missing or double flags harmless.
 */
export function finalizeCandidate(
  title: string,
  artist: string,
  channelTitle?: string,
  options?: FinalizeOptions,
): FinalizedSongMetadata {
  if (options?.alreadyNormalized) {
    // Already produced by normalizeSong(): never split or clean again.
    const t = (title || "").trim();
    const a = (artist || "").trim() || "Unknown Artist";
    return {
      title: t,
      artist: a,
      canonicalTitle: canonicalString(t),
      canonicalArtist: canonicalArtist(a),
    };
  }

  const raw = decodeHtml(title || "").trim();
  const channel = decodeHtml(channelTitle ?? "").trim();
  const known = (options?.knownArtist ?? "").trim();

  // 1. Strip YouTube clutter (official/audio/lyric tags, pipes, emoji…).
  const cleaned = cleanTitle(raw) || raw;

  // 2. High-confidence "[Artist] - [Song]" split. Structured artist metadata
  //    (YT Music `artists[]`) boosts confidence and wins over the prefix.
  const prefix = extractArtistPrefix(cleaned, channel, known || undefined);

  const displayTitle = prefix ? prefix.restTitle : cleaned;
  const baseArtist = prefix
    ? known || prefix.artist
    : known || inferArtist(cleaned, channel);
  const displayArtist = normalizeArtist(baseArtist || "Unknown Artist");

  return {
    title: displayTitle,
    artist: displayArtist,
    canonicalTitle: canonicalString(displayTitle),
    canonicalArtist: canonicalArtist(displayArtist),
  };
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
    const structuredArtist = artists.map((a) => a.name).join(", ");

    const finalized = finalizeCandidate(
      title,
      structuredArtist || "Unknown Artist",
      undefined,
      { knownArtist: structuredArtist || undefined },
    );

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
      title: finalized.title,
      // Preserve the original structured artist names; `artist` carries the
      // canonicalized (normalized) display form used for matching.
      artists,
      artist: finalized.artist,
      duration: secondsToMmss(durationSeconds),
      duration_seconds: durationSeconds,
      thumbnails: thumbnail ? [{ url: thumbnail }] : [],
      canonicalTitle: finalized.canonicalTitle,
      canonicalArtist: finalized.canonicalArtist,
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
  // Search results already passed through normalizeSong() — pass the raw
  // channel through as the channel with alreadyNormalized so the fields stay
  // byte-for-byte intact (idempotence guard).
  const finalized = finalizeCandidate(title, artist, song.rawChannel || undefined, {
    alreadyNormalized: true,
  });
  return {
    videoId: song.videoId,
    title: finalized.title,
    artists: artist ? [{ name: artist }] : [],
    artist: finalized.artist,
    duration: secondsToMmss(durationSeconds),
    duration_seconds: durationSeconds,
    thumbnails: song.thumbnail ? [{ url: song.thumbnail }] : [],
    canonicalTitle: finalized.canonicalTitle,
    canonicalArtist: finalized.canonicalArtist,
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

// ---------------------------------------------------------------------------
// Browser-side metadata & radio
// ---------------------------------------------------------------------------

/**
 * Extract the tracks of a YouTube / YouTube Music playlist URL from the
 * BROWSER via Piped ``/playlists/{id}`` (open CORS, no server egress to
 * YouTube). Returns importer-shaped raw track rows — each carrying a canonical
 * ``videoId`` so the server matcher treats them as exact matches.
 *
 *   { title, artist, album, duration, videoId? }
 *
 * Returns an empty array when the URL isn't a YouTube playlist or Piped can't
 * resolve it (caller falls back to the server-side parse).
 */
export async function extractPlaylistOnBrowser(url: string): Promise<
  Array<{
    title: string; artist: string; album?: string; duration?: number;
    thumbnail?: string; videoId?: string;
  }>
> {
  if (!url || !/youtube\.com|youtu\.be/i.test(url)) return [];
  let playlistId: string | null = null;
  const listMatch = url.match(/[?&]list=([^&#]+)/);
  if (listMatch) playlistId = listMatch[1];
  if (!playlistId) return [];

  try {
    const items = await invidiousProvider.getPlaylistItems(playlistId);
    const rows = items
      .filter((s) => /^[a-zA-Z0-9_-]{11}$/.test(s.videoId))
      .map((s) => ({
        title: (s.title || "").trim(),
        artist: (s.artist || "Unknown Artist").trim(),
        album: "",
        duration: Number(s.duration) || 0,
        thumbnail: (s.thumbnail || "").trim(),
        videoId: s.videoId,
      }));
    // A playlist that resolved to zero *canonical* tracks is treated as a
    // failure so the caller can fall back to the server-side provider chain.
    return rows.length > 0 ? rows : [];
  } catch (err) {
    console.warn(`BrowserYouTubeMusicResolver: playlist extract failed:`, err);
    return [];
  }
}

/**
 * Resolve a track's metadata from the BROWSER via Piped ``/streams/{id}``
 * (open CORS, no server egress to YouTube). Returns a minimal ``Song``-shaped
 * object or ``null`` when the track can't be resolved in the browser.
 */
export async function resolveMetadataOnBrowser(videoId: string): Promise<Song | null> {
  if (!videoId) return null;
  try {
    const data = await fetchPipedStreams(videoId);
    if (!data || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
    const title = (data.title || "").trim();
    const uploader = (data.uploader || "").trim();
    const thumb = data.thumbnailUrl || "";
    const finalized = finalizeCandidate(title, uploader, uploader);
    return {
      videoId,
      title: finalized.title || `YouTube Track (${videoId})`,
      artist: finalized.artist || "Unknown Artist",
      thumbnail: thumb,
      duration: Number(data.duration) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve radio / related tracks from the BROWSER via Piped ``/streams/{id}``
 * ``relatedStreams`` (the equivalent of YT Music's "related"/watch playlist
 * but served by a public instance the browser can reach directly). Tracks
 * already in ``exclude`` are dropped. Returns an array of ``Song``.
 */
export async function resolveRelatedOnBrowser(
  videoId: string,
  exclude: string[] = [],
): Promise<Song[]> {
  if (!videoId) return [];
  try {
    const data = await fetchPipedStreams(videoId);
    if (!data || !Array.isArray(data.relatedStreams)) return [];
    const excluded = new Set(exclude || []);
    const seen = new Set<string>();
    const songs: Song[] = [];
    for (const r of data.relatedStreams) {
      if (r?.type && r.type !== "stream") continue;
      const m = typeof r?.url === "string" ? r.url.match(/[?&]v=([^&]+)/) : null;
      const id = m ? m[1] : null;
      if (!id || excluded.has(id) || seen.has(id) || !/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
      seen.add(id);
      const title = (r.title || "").trim();
      const uploader = (r.uploaderName || "").trim();
      const finalized = finalizeCandidate(title, uploader, uploader);
      songs.push({
        videoId: id,
        title: finalized.title || "Untitled",
        artist: finalized.artist || "Unknown Artist",
        thumbnail: r.thumbnail || "",
        duration: Number(r.duration) || 0,
      });
    }
    return songs;
  } catch {
    return [];
  }
}