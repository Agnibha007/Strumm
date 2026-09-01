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

// Health-check state
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
const HEALTH_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const HEALTH_CHECK_TIMEOUT = 4_000; // 4s per instance

/**
 * Ping a Piped instance to verify it is responsive.
 * Uses the health endpoint; falls back to a HEAD request on the base URL.
 */
async function checkInstanceHealth(baseUrl: string): Promise<boolean> {
  // Try the dedicated /healthz endpoint first
  for (const path of ["/healthz", "/health", "/"]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
      const res = await fetch(`${baseUrl}${path}`, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || res.status === 404) {
        // 404 means the endpoint doesn't exist but the server is alive
        return true;
      }
    } catch {
      // Try the next path
    }
  }
  return false;
}

/**
 * Run a health check on all known instances and update the healthy set.
 * Only ever REMOVES instances (an instance demoted for a real request
 * failure or a failed ping stays out; live/discovered instances are seeded
 * healthy and simply drop out over time if they stop responding).
 */
async function runHealthCheck(): Promise<void> {
  if (!cachedInstances) return;

  const current = cachedInstances.apiUrls;
  const results = await Promise.allSettled(
    current.map(async (url) => {
      const healthy = await checkInstanceHealth(url);
      return { url, healthy };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && !result.value.healthy) {
      cachedInstances!.healthyUrls.delete(result.value.url);
      unhealthyUrls.add(result.value.url);
    }
  }
}

/**
 * Start the periodic health‑check background loop.
 * Runs immediately (non‑blocking) and then every HEALTH_CHECK_INTERVAL.
 */
function startHealthChecks(): void {
  if (healthCheckInterval) return; // already running

  // Run first check after a short delay so initial search isn't blocked
  const initialDelay = setTimeout(() => {
    runHealthCheck().catch(() => {});
    clearTimeout(initialDelay);
  }, 5_000);

  healthCheckInterval = setInterval(() => {
    runHealthCheck().catch(() => {});
  }, HEALTH_CHECK_INTERVAL);
}

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
    // Start background health checks
    startHealthChecks();
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

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function fetchPiped<T>(path: string, timeoutMs = 8_000): Promise<T | null> {
  const instances = await discoverInstances();

  for (let i = 0; i < instances.length; i++) {
    const base = instances[i];
    const url = `${base}${path}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        demoteInstance(base);
        if (!warnedUrls.has(base)) {
          warnedUrls.add(base);
          console.warn(`PipedProvider: HTTP ${res.status} from ${base}${path}`);
        }
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
