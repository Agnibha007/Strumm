/**
 * InvidiousProvider — searches YouTube via a public Piped instance.
 *
 * Piped is a privacy-friendly YouTube frontend with a public JSON API.
 * We dynamically fetch the official instance list at runtime to find
 * working instances, so no hardcoded list gets stale.
 *
 * This provider acts as a zero-cost fallback when the YouTube Data API
 * key is unavailable or quota-exceeded.
 *
 * API docs: https://docs.piped.video/docs/api-documentation/
 * Instances: https://piped-instances.kavin.rocks/
 */

import type { SearchProvider, SearchResults, SongResult, AlbumResult, ArtistResult } from "./SearchProvider";
import { normalizeSong } from "../metadata/MetadataNormalizer";
import { decodeHtml } from "web/lib/api";

// ---------------------------------------------------------------------------
// Piped instance discovery
// ---------------------------------------------------------------------------

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

// Hardcoded fallback instances in case the instance list fetch fails
const FALLBACK_INSTANCES = [
  "https://api.piped.private.coffee",
];

/** Cache for the discovered instance list (refreshed every 10 minutes). */
let cachedInstances: { apiUrls: string[]; fetchedAt: number } | null = null;
const INSTANCE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Promise cache to deduplicate concurrent fetchInstanceList calls
let pendingInstanceFetch: Promise<string[]> | null = null;

async function fetchInstanceList(): Promise<string[]> {
  const apiUrls: string[] = [];

  // Check user-configured instance first
  const userInstance = typeof process !== "undefined" && process.env
    ? (process.env as Record<string, string | undefined>).NEXT_PUBLIC_INVIDIOUS_INSTANCE
    : undefined;

  if (userInstance && typeof userInstance === "string" && userInstance.trim()) {
    apiUrls.push(userInstance.trim().replace(/\/+$/, ""));
  }

  // Fetch the official instance list
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(INSTANCE_LIST_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const entries: PipedInstanceEntry[] = await res.json();
      // Only include instances with good uptime and an api_url
      for (const entry of entries) {
        const uptime = entry.uptime_24h ?? 0;
        if (uptime >= 90 && entry.api_url) {
          const url = entry.api_url.replace(/\/+$/, "");
          if (!apiUrls.includes(url)) {
            apiUrls.push(url);
          }
        }
      }
    }
  } catch {
    // Instance list fetch failed — use fallbacks
  }

  // Add hardcoded fallbacks only if we ended up with nothing
  if (apiUrls.length === 0) {
    for (const fallback of FALLBACK_INSTANCES) {
      if (!apiUrls.includes(fallback)) apiUrls.push(fallback);
    }
  }

  return apiUrls;
}

async function discoverInstances(): Promise<string[]> {
  // Return cached list if still fresh
  if (cachedInstances && Date.now() - cachedInstances.fetchedAt < INSTANCE_CACHE_TTL) {
    return cachedInstances.apiUrls;
  }

  // Deduplicate concurrent fetchInstanceList calls
  if (!pendingInstanceFetch) {
    pendingInstanceFetch = fetchInstanceList().then((apiUrls) => {
      cachedInstances = { apiUrls, fetchedAt: Date.now() };
      pendingInstanceFetch = null;
      return apiUrls;
    }).catch((err) => {
      pendingInstanceFetch = null;
      // If the fetch fails and we have no cached list, fall through to fallbacks
      if (!cachedInstances) {
        const urls = [...FALLBACK_INSTANCES];
        cachedInstances = { apiUrls: urls, fetchedAt: Date.now() };
        return urls;
      }
      return cachedInstances.apiUrls;
    });
  }

  return pendingInstanceFetch;
}

/** Invalidate the instance cache so the next call re-fetches the list. */
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
        console.warn(`PipedProvider: HTTP ${res.status} from ${base}${path}`);
        continue; // try next instance
      }
      return await res.json() as T;
    } catch (err: any) {
      console.warn(`PipedProvider: Network error for ${base}${path}:`, err?.message ?? err);
    }
  }

  return null; // all instances failed
}

// ---------------------------------------------------------------------------
// Piped API response types
// ---------------------------------------------------------------------------

interface PipedStreamItem {
  url: string;               // "/watch?v=VIDEOID"
  type: "stream";
  title: string;
  thumbnail: string;
  uploaderName: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  uploadedDate: string;
  shortDescription: string;
  duration: number;          // seconds
  views: number;
  uploaded: number;          // epoch ms
  uploaderVerified: boolean;
  isShort: boolean;
}

interface PipedChannelItem {
  url: string;               // "/channel/CHANNELID"
  type: "channel";
  name: string;
  thumbnail: string;
  subscribers: number;
  description: string;
  videos: number;
}

interface PipedPlaylistItem {
  url: string;               // "/playlist?list=PLAYLISTID"
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
    url: string;             // "/watch?v=VIDEOID"
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

/** Extract YouTube video ID from a Piped URL like "/watch?v=VIDEOID". */
function extractVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

/** Extract channel ID from a Piped URL like "/channel/CHANNELID". */
function extractChannelId(url: string): string | null {
  const m = url.match(/\/channel\/([^/?&]+)/);
  return m ? m[1] : null;
}

/** Extract playlist ID from a Piped URL like "/playlist?list=PLAYLISTID". */
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
    // Piped filter: "all", "videos", "channels", "playlists", "music_songs", etc.
    const filter = type === "all" ? "all"
      : type === "video" ? "videos"
        : type === "channel" ? "channels"
          : type === "playlist" ? "playlists"
            : "all";

    const data = await fetchPiped<PipedSearchResponse>(
      `/search?q=${encodeURIComponent(q)}&filter=${filter}`,
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
    // Piped has a /streams/:videoId endpoint but we keep this simple
    // since the primary provider (YouTube Data API) handles details.
    return null;
  },

  async getPlaylistItems(playlistId: string): Promise<SongResult[]> {
    const data = await fetchPiped<PipedPlaylistDetail>(
      `/playlists/${encodeURIComponent(playlistId)}`,
      10_000,
    );

    if (!data || !Array.isArray(data.videos)) return [];

    return data.videos.map((v) => {
      const videoId = extractVideoId(v.url);
      if (!videoId) return null;
      return normalizeSong(
        videoId,
        decodeHtml(v.title) ?? "Untitled",
        decodeHtml(v.uploaderName) ?? "Unknown Artist",
        v.thumbnail,
        v.duration ?? 0,
      );
    }).filter(Boolean) as SongResult[];
  },
};
