/**
 * InvidiousProvider — searches YouTube via public Piped instances.
 *
 * Piped is a privacy-friendly YouTube frontend with a public JSON API.
 * We try hardcoded known‑good instances FIRST so searches are fast,
 * then refresh the official instance list in the background for future use.
 *
 * This provider acts as a zero‑cost fallback when the YouTube Data API
 * key is unavailable or quota‑exceeded.
 *
 * API docs: https://docs.piped.video/docs/api-documentation/
 * Instances: https://piped-instances.kavin.rocks/
 */

import type { SearchProvider, SearchResults, SongResult, AlbumResult, ArtistResult } from "./SearchProvider";
import { normalizeSong } from "../metadata/MetadataNormalizer";
import { decodeHtml } from "web/lib/api";

// ---------------------------------------------------------------------------
// Piped instances — tried in order
// ---------------------------------------------------------------------------

/**
 * Known‑good Piped instances checked periodically.
 * These are tried FIRST so searches don't block on the instance‑list fetch.
 * Order matters: verified‑live instances lead (2026‑09). Dropped instances
 * that no longer serve the Piped API — ``pipedapi.adminforge.de`` now
 * redirects to a non‑Piped website and ``pipedapi.smnz.de`` is unreachable.
 * Instances that fail at runtime are demoted per session (see ``fetchPiped``),
 * so one dead instance can't spam errors for every query.
 */
const HARDCODED_INSTANCES: string[] = [
  "https://api.piped.private.coffee",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.r4fo.com",
];

/**
 * Instances known to answer browser origins with ``Access-Control-Allow-
 * Origin: *``. The others (kavin.rocks, r4fo.com) historically omit the CORS
 * header, so any browser ``fetch`` to them is thrown away by the browser with
 * a CORS TypeError — pure console noise on every resolution. Browser-side
 * fetches try ONLY these first; the rest are kept for server-side contexts
 * and as a last resort.
 */
const BROWSER_SAFE_INSTANCES = new Set([
  "https://api.piped.private.coffee",
]);

const INSTANCE_LIST_URL = "https://piped-instances.kavin.rocks/";

interface PipedInstanceEntry {
  name: string;
  api_url: string;
  locations: string;
  version: string;
  up_to_date: boolean;
  cdn: boolean;
  registered: number;
  last_checked: number;
  cache: boolean;
  s3_enabled: boolean;
  image_proxy_url: string;
  registration_disabled: boolean;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
}

/** Cache for the discovered instance list (refreshed every 10 minutes). */
let cachedInstances: {
  apiUrls: string[];
  fetchedAt: number;
  /** URLs that have been verified healthy via a ping. */
  healthyUrls: Set<string>;
} | null = null;
const INSTANCE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Session‑level demotion: instances that failed a real request are skipped
// for the rest of the page session so a single dead instance can't spray a
// console error for every query in an import.
const unhealthyUrls = new Set<string>();
const warnedUrls = new Set<string>();

// Promise cache to deduplicate concurrent fetchInstanceList calls
let pendingInstanceFetch: Promise<string[]> | null = null;

/**
 * Returns the list of Piped instance API URLs to try, in order.
 * Hardcoded instances come first (always available, no fetch needed),
 * followed by user‑configured and dynamically‑discovered instances.
 */
async function discoverInstances(): Promise<string[]> {
  // Return cached list if still fresh (includes hardcoded ones)
  if (cachedInstances && Date.now() - cachedInstances.fetchedAt < INSTANCE_CACHE_TTL) {
    // Filter out any instances health checks have marked unhealthy
    const healthy = cachedInstances.healthyUrls;
    return healthy.size > 0
      ? cachedInstances.apiUrls.filter((url) => healthy.has(url) && !unhealthyUrls.has(url))
      : cachedInstances.apiUrls.filter((url) => !unhealthyUrls.has(url));
  }

  // Build the full list: hardcoded → user‑configured → live discovery
  const apiUrls = [...HARDCODED_INSTANCES];

  // Check user‑configured instance via env var
  const userInstance = typeof process !== "undefined" && process.env
    ? (process.env as Record<string, string | undefined>).NEXT_PUBLIC_INVIDIOUS_INSTANCE
    : undefined;

  if (userInstance && typeof userInstance === "string" && userInstance.trim()) {
    const cleaned = userInstance.trim().replace(/\/+$/, "");
    if (!apiUrls.includes(cleaned)) apiUrls.push(cleaned);
  }

  // Immediately cache the hardcoded list so searches don't block
  if (!cachedInstances) {
    cachedInstances = {
      apiUrls,
      fetchedAt: Date.now(),
      // Seed the healthy set with all instances initially
      healthyUrls: new Set(apiUrls),
    };
  }

  // Fetch the official instance list in the BACKGROUND — don't await it
  if (!pendingInstanceFetch) {
    pendingInstanceFetch = fetchLiveInstances().then((liveUrls) => {
      // Merge live URLs (append after hardcoded ones)
      const merged = [...HARDCODED_INSTANCES];
      if (userInstance?.trim()) {
        const cleaned = userInstance.trim().replace(/\/+$/, "");
        if (!merged.includes(cleaned)) merged.push(cleaned);
      }
      for (const url of liveUrls) {
        if (!merged.includes(url)) merged.push(url);
      }
      cachedInstances = {
        apiUrls: merged,
        fetchedAt: Date.now(),
        // Preserve healthy set; new live instances start as healthy
        healthyUrls: new Set([...cachedInstances!.healthyUrls, ...liveUrls]),
      };
      for (const url of liveUrls) unhealthyUrls.delete(url);
      pendingInstanceFetch = null;
      return merged;
    }).catch(() => {
      pendingInstanceFetch = null;
      return cachedInstances?.apiUrls ?? HARDCODED_INSTANCES;
    });
  }

  // Return only healthy instances (or all if health check hasn't run yet)
  if (cachedInstances.healthyUrls.size > 0) {
    return apiUrls.filter(
      (url) => cachedInstances!.healthyUrls.has(url) && !unhealthyUrls.has(url),
    );
  }
  return apiUrls.filter((url) => !unhealthyUrls.has(url));
}

/** Fetch the official Piped instance list and return healthy API URLs. */
async function fetchLiveInstances(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(INSTANCE_LIST_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const entries: PipedInstanceEntry[] = await res.json();
      return entries
        .filter((e) => (e.uptime_24h ?? 0) >= 90 && e.api_url)
        .map((e) => e.api_url.replace(/\/+$/, ""));
    }
  } catch {
    // Instance list fetch failed — use hardcoded ones
  }
  return [];
}

/** Invalidate the instance cache so the next call re‑fetches the list. */
export function refreshInstances(): void {
  cachedInstances = null;
}

/**
 * Return the Piped instance API base URLs currently considered healthy, in
 * order. Shared by search and browser-side direct-audio extraction so both use
 * the same live/demoted instance set.
 */
export async function discoverPipedInstances(): Promise<string[]> {
  const all = await discoverInstances();
  // Order CORS-safe instances first so browser fetches aren't held up by
  // instances that will fail a browser fetch (CORS) regardless of uptime.
  return [...[...all].filter((u) => BROWSER_SAFE_INSTANCES.has(u)), ...[...all].filter((u) => !BROWSER_SAFE_INSTANCES.has(u))];
}

// ---------------------------------------------------------------------------
// Piped /streams — shared by direct-audio and browser-side radio/metadata
// ---------------------------------------------------------------------------

/** A single Piped stream info response (``GET /streams/{id}``). */
export interface PipedStreamsData {
  title?: string;
  duration?: number;
  uploader?: string;
  thumbnailUrl?: string;
  audioStreams?: Array<{ url?: string; mimeType?: string; bitrate?: number }>;
  videoStreams?: Array<{
    url?: string;
    mimeType?: string;
    bitrate?: number;
    videoOnly?: boolean;
  }>;
  relatedStreams?: Array<{
    url?: string;
    type?: string;
    title?: string;
    uploaderName?: string;
    thumbnail?: string;
    duration?: number;
  }>;
}

/**
 * Fetch ``/streams/{videoId}`` from the live Piped instances (in order),
 * returning the first successful payload or ``null`` when every instance
 * fails. Reuses search's instance discovery + runtime demotion, so a dead
 * instance is skipped for later calls.
 */
export async function fetchPipedStreams(videoId: string): Promise<PipedStreamsData | null> {
  const instances = await discoverPipedInstances();
  for (const base of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4_000);
      const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        demoteInstance(base);
        // A decisive non-2xx (e.g. YouTube bot-block 500) means this instance
        // can't serve this video at all — don't burn time on the remaining
        // CORS-hostile instances for the same network-independent 500.
        if (res.status >= 500) break;
        continue;
      }
      return (await res.json()) as PipedStreamsData;
    } catch {
      demoteInstance(base);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function fetchPiped<T>(path: string, timeoutMs = 8_000): Promise<T | null> {
  const instances = await discoverPipedInstances();

  for (let i = 0; i < instances.length; i++) {
    const base = instances[i];
    const url = `${base}${path}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 6_000));
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        demoteInstance(base);
        if (!warnedUrls.has(base)) {
          warnedUrls.add(base);
          console.warn(`PipedProvider: HTTP ${res.status} from ${base}${path}`);
        }
        // A clean 5xx is a network-independent bot-block / outage: stop paying
        // timeouts on the remaining (CORS-hostile) instances for the same call.
        if (res.status >= 500) break;
        continue;
      }
      return (await res.json()) as T;
    } catch (err: any) {
      demoteInstance(base);
      if (!warnedUrls.has(base)) {
        warnedUrls.add(base);
        console.warn(`PipedProvider: Network error for ${base}${path}:`, err?.message ?? err);
      }
    }
  }

  return null; // all instances failed
}

/**
 * Demote an instance that just failed a real request so later queries skip it.
 * Future searches in this session no longer pay the failed round‑trip or
 * re‑emit the console error for it.
 */
function demoteInstance(baseUrl: string): void {
  unhealthyUrls.add(baseUrl);
  if (cachedInstances) cachedInstances.healthyUrls.delete(baseUrl);
}

// ---------------------------------------------------------------------------
// Piped API response types
// ---------------------------------------------------------------------------

interface PipedStreamItem {
  url: string;
  type: "stream";
  title: string;
  thumbnail: string;
  uploaderName: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  uploadedDate: string;
  shortDescription: string;
  duration: number;
  views: number;
  uploaded: number;
  uploaderVerified: boolean;
  isShort: boolean;
}

interface PipedChannelItem {
  url: string;
  type: "channel";
  name: string;
  thumbnail: string;
  subscribers: number;
  description: string;
  videos: number;
}

interface PipedPlaylistItem {
  url: string;
  type: "playlist";
  name: string;
  thumbnail: string;
  uploaderName: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  videos: number;
}

interface PipedSearchResponse {
  items: Array<PipedStreamItem | PipedChannelItem | PipedPlaylistItem>;
  nextpage?: string;
}

interface PipedPlaylistDetail {
  videos: Array<{
    url: string;
    title: string;
    thumbnail: string;
    uploaderName: string;
    uploaderUrl: string;
    uploadedDate: string;
    duration: number;
    views: number;
    uploaderVerified: boolean;
  }>;
  nextpage?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

function extractChannelId(url: string): string | null {
  const m = url.match(/\/channel\/([^/?&]+)/);
  return m ? m[1] : null;
}

function extractPlaylistId(url: string): string | null {
  const m = url.match(/[?&]list=([^&]+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function pipedStreamToSong(item: PipedStreamItem): SongResult | null {
  const videoId = extractVideoId(item.url);
  if (!videoId) return null;
  return normalizeSong(
    videoId,
    decodeHtml(item.title) ?? "Untitled",
    decodeHtml(item.uploaderName) ?? "Unknown Artist",
    item.thumbnail,
    item.duration ?? 0,
  );
}

function pipedPlaylistToAlbum(item: PipedPlaylistItem): AlbumResult | null {
  const id = extractPlaylistId(item.url);
  if (!id) return null;
  return {
    id,
    title: decodeHtml(item.name) ?? "Untitled",
    artist: decodeHtml(item.uploaderName) ?? "Unknown Artist",
    thumbnail: item.thumbnail,
    year: "",
  };
}

function pipedChannelToArtist(item: PipedChannelItem): ArtistResult | null {
  const id = extractChannelId(item.url);
  if (!id) return null;
  return {
    id,
    name: decodeHtml(item.name) ?? "Unknown",
    thumbnail: item.thumbnail,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const invidiousProvider: SearchProvider = {
  name: "Piped (fallback)",

  async search(q: string, type: string): Promise<SearchResults> {
    const filter =
      type === "all" ? "all"
      : type === "video" ? "videos"
      : type === "channel" ? "channels"
      : type === "playlist" ? "playlists"
      : "all";

    const data = await fetchPiped<PipedSearchResponse>(
      `/search?q=${encodeURIComponent(q)}&filter=${filter}`,
      10_000, // slightly longer timeout for search
    );

    const results: SearchResults = { songs: [], albums: [], artists: [] };

    if (data && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (item.type === "stream" && (type === "all" || type === "video")) {
          const song = pipedStreamToSong(item);
          if (song) results.songs.push(song);
        } else if (item.type === "playlist" && (type === "all" || type === "playlist")) {
          const album = pipedPlaylistToAlbum(item);
          if (album) results.albums.push(album);
        } else if (item.type === "channel" && (type === "all" || type === "channel")) {
          const artist = pipedChannelToArtist(item);
          if (artist) results.artists.push(artist);
        }
      }
    }

    return results;
  },

  async getVideoDetails(_videoId: string): Promise<SongResult | null> {
    return null;
  },

  async getPlaylistItems(playlistId: string): Promise<SongResult[]> {
    const data = await fetchPiped<PipedPlaylistDetail>(
      `/playlists/${encodeURIComponent(playlistId)}`,
      10_000,
    );

    if (!data || !Array.isArray(data.videos)) return [];

    return data.videos
      .map((v) => {
        const videoId = extractVideoId(v.url);
        if (!videoId) return null;
        return normalizeSong(
          videoId,
          decodeHtml(v.title) ?? "Untitled",
          decodeHtml(v.uploaderName) ?? "Unknown Artist",
          v.thumbnail,
          v.duration ?? 0,
        );
      })
      .filter(Boolean) as SongResult[];
  },
};
