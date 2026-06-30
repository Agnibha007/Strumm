/**
 * YouTubeProvider — searches the YouTube Data API v3 and normalises responses
 * into the application‑internal { songs, albums, artists } format.
 *
 * Environment variables
 * ---------------------
 *   YOUTUBE_API_KEY  – required; a Google Cloud API key with the
 *                      "YouTube Data API v3" service enabled.
 *
 * Quota
 * -----
 *   Every request costs **1 unit**.  The free tier includes 10 000 units/day.
 *   - search(): 1 unit (retrieves videos, playlists AND channels in one call)
 *   - getVideoDetails(): 1 unit
 *   - getPlaylistItems(): 2 units (1 for playlistItems + 1 for batch videos)
 *
 * Duration
 * --------
 *   The `/search` endpoint only returns `snippet` data (no duration).
 *   Search results therefore report `duration: 0`.  The `getVideoDetails()`
 *   and `getPlaylistItems()` methods parse the real ISO 8601 duration from
 *   the `/videos` endpoint.
 */

import type { SearchProvider, SearchResults, SongResult, AlbumResult, ArtistResult } from "./SearchProvider";
import { searchCache } from "./cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error(
      "YouTubeProvider: YOUTUBE_API_KEY environment variable is not set. " +
      "Get a key at https://console.cloud.google.com/apis/credentials",
    );
  }
  return key;
}

/** Parse ISO 8601 duration (e.g. "PT1M30S") → seconds. */
export function parseDurationIso8601(iso: string): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const hours = parseInt(m[1] ?? "0", 10);
  const minutes = parseInt(m[2] ?? "0", 10);
  const seconds = parseInt(m[3] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/** Pick the best available thumbnail URL from a YouTube snippet. */
function pickThumbnail(thumbnails: Record<string, { url: string }> | undefined): string {
  if (!thumbnails) return "";
  // Prefer medium, fall back to high, then default
  return (
    thumbnails.medium?.url ||
    thumbnails.high?.url ||
    thumbnails.default?.url ||
    ""
  );
}

/** Build a cache key from the endpoint + params. */
function cacheKey(endpoint: string, params: Record<string, string>): string {
  return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** Error thrown when the YouTube API returns an auth / quota failure (HTTP 403). */
export class YouTubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeAuthError";
  }
}

async function fetchJson(path: string, params: Record<string, string>): Promise<any | null> {
  const url = `${YT_API_BASE}${path}?${new URLSearchParams({ ...params, key: apiKey() })}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 403 = auth failure — throw so the API route can return a clear error
      if (res.status === 403) {
        throw new YouTubeAuthError(
          `YouTube Data API returned 403. Check that YOUTUBE_API_KEY is valid ` +
          `and the YouTube Data API v3 is enabled in your Google Cloud project.`,
        );
      }
      console.warn(
        `YouTubeProvider: HTTP ${res.status} for ${path}`,
        body.slice(0, 300),
      );
      return null;
    }
    return await res.json();
  } catch (err: any) {
    // Re-throw auth errors so callers can distinguish them from network issues
    if (err instanceof YouTubeAuthError) throw err;
    console.warn(`YouTubeProvider: Network error for ${path}:`, err?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function ytItemToSong(item: any): SongResult | null {
  const id = item.id?.videoId;
  const snippet = item.snippet;
  if (!id || !snippet) return null;
  return {
    videoId: id,
    title: snippet.title ?? "Untitled",
    artist: snippet.channelTitle ?? "Unknown Artist",
    thumbnail: pickThumbnail(snippet.thumbnails),
    duration: 0, // /search doesn't return duration; use getVideoDetails() for real value
  };
}

function ytItemToAlbum(item: any): AlbumResult | null {
  const id = item.id?.playlistId;
  const snippet = item.snippet;
  if (!id || !snippet) return null;
  return {
    id,
    title: snippet.title ?? "Untitled",
    artist: snippet.channelTitle ?? "Unknown Artist",
    thumbnail: pickThumbnail(snippet.thumbnails),
    year: "",
  };
}

function ytItemToArtist(item: any): ArtistResult | null {
  const id = item.id?.channelId;
  const snippet = item.snippet;
  if (!id || !snippet) return null;
  return {
    id,
    name: snippet.title ?? "Unknown",
    thumbnail: pickThumbnail(snippet.thumbnails),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const youTubeProvider: SearchProvider = {
  name: "YouTube Data API v3",

  async search(q: string, type: string): Promise<SearchResults> {
    const ck = cacheKey("search", { q, type });
    const cached = searchCache.get(ck);
    if (cached) return cached as SearchResults;

    // YouTube doesn't support "all" — we fetch every requested type in one call
    const ytType = type === "all"
      ? "video,playlist,channel"
      : type === "video"
        ? "video"
        : type === "playlist"
          ? "playlist"
          : "channel";

    const data = await fetchJson("/search", {
      part: "snippet",
      q,
      type: ytType,
      maxResults: "20",
    });

    const results: SearchResults = { songs: [], albums: [], artists: [] };

    if (data && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (item.id?.videoId && (type === "all" || type === "video")) {
          const song = ytItemToSong(item);
          if (song) results.songs.push(song);
        } else if (item.id?.playlistId && (type === "all" || type === "playlist")) {
          const album = ytItemToAlbum(item);
          if (album) results.albums.push(album);
        } else if (item.id?.channelId && (type === "all" || type === "channel")) {
          const artist = ytItemToArtist(item);
          if (artist) results.artists.push(artist);
        }
      }
    }

    searchCache.set(ck, results);
    return results;
  },

  async getVideoDetails(videoId: string): Promise<SongResult | null> {
    const ck = cacheKey("videos", { id: videoId });
    const cached = searchCache.get(ck);
    if (cached) return cached as SongResult;

    const data = await fetchJson("/videos", {
      part: "snippet,contentDetails",
      id: videoId,
    });

    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
      return null;
    }

    const item = data.items[0];
    const snippet = item.snippet;
    const details = item.contentDetails;

    if (!snippet) return null;

    const result: SongResult = {
      videoId,
      title: snippet.title ?? "Untitled",
      artist: snippet.channelTitle ?? "Unknown Artist",
      thumbnail: pickThumbnail(snippet.thumbnails),
      duration: details?.duration ? parseDurationIso8601(details.duration) : 0,
    };

    searchCache.set(ck, result);
    return result;
  },

  async getPlaylistItems(playlistId: string): Promise<SongResult[]> {
    const ck = cacheKey("playlistItems", { playlistId });
    const cached = searchCache.get(ck);
    if (cached) return cached as SongResult[];

    // 1) Fetch playlist items (snippet only — no duration)
    const data = await fetchJson("/playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50",
    });

    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
      return [];
    }

    const videoIds: string[] = [];
    const items: SongResult[] = [];

    for (const item of data.items) {
      const snippet = item.snippet;
      const vid = snippet?.resourceId?.videoId;
      if (!vid) continue;
      videoIds.push(vid);
      items.push({
        videoId: vid,
        title: snippet.title ?? "Untitled",
        artist: snippet.videoOwnerChannelTitle ?? snippet.channelTitle ?? "Unknown Artist",
        thumbnail: pickThumbnail(snippet.thumbnails),
        duration: 0, // patched below
      });
    }

    // 2) Batch‑fetch video details for durations (up to 50 at once)
    if (videoIds.length > 0) {
      const vidData = await fetchJson("/videos", {
        part: "contentDetails",
        id: videoIds.join(","),
      });

      if (vidData && Array.isArray(vidData.items)) {
        const durationMap = new Map<string, number>();
        for (const v of vidData.items) {
          if (v.id && v.contentDetails?.duration) {
            durationMap.set(v.id, parseDurationIso8601(v.contentDetails.duration));
          }
        }
        for (const song of items) {
          song.duration = durationMap.get(song.videoId) ?? 0;
        }
      }
    }

    searchCache.set(ck, items);
    return items;
  },
};
