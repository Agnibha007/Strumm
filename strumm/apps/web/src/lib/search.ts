/**
 * Search API client — calls the Next.js API route /api/search which proxies
 * to the YouTube Data API v3 on the server side, with an automatic fallback
 * to a public Invidious instance when the API key is missing or quota is
 * exceeded.
 *
 * Primary path:  browser → /api/search (Next.js) → YouTube Data API v3
 * Fallback path:  browser → Invidious instance (direct, no CORS issues)
 *
 * No external dependencies — the Invidious fallback uses standard fetch().
 */

import { invidiousProvider } from "web/services/search";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  type?: "video" | "playlist" | "channel" | "all";
  page?: number;
  sort?: "relevance" | "views";
}

export interface SearchResults {
  songs: import("@strumm/types").Song[];
  albums: any[];
  artists: any[];
}

/**
 * Search across videos (songs), playlists (albums), and channels (artists).
 *
 * Tries the YouTube Data API v3 first (via same-origin /api/search proxy).
 * Falls back to a public Invidious instance on any failure (network error,
 * 503, missing API key, quota exceeded).
 */
export async function searchYouTube(
  opts: SearchOptions,
): Promise<SearchResults> {
  const { query, type } = opts;

  if (!query.trim()) {
    return { songs: [], albums: [], artists: [] };
  }

  // -------------------------------------------------------------------
  // 1. Try YouTube Data API v3 (via next.js API route)
  // -------------------------------------------------------------------
  try {
    const params = new URLSearchParams({
      q: query,
      type: type || "all",
      page: String(opts.page || 1),
    });
    const res = await fetch(`/api/search?${params.toString()}`, {
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const json = await res.json();
      // Surface any warning from the server (e.g., YouTube fallback active)
      if (json.warning) {
        console.warn("Search API warning:", json.warning);
      }
      if (json.success && json.data) {
        return {
          songs: json.data.songs || [],
          albums: json.data.albums || [],
          artists: json.data.artists || [],
        };
      }
    }

    // Non-OK response or missing data — log and fall through to fallback
    if (res.status === 503) {
      console.warn("YouTube API unavailable (503), falling back to Invidious.");
    } else {
      console.warn(`YouTube API returned HTTP ${res.status}, falling back to Invidious.`);
    }
  } catch (err) {
    console.warn("YouTube API request failed, falling back to Invidious:", err);
  }

  // -------------------------------------------------------------------
  // 2. Fallback: Invidious (direct from browser, no API key needed)
  // -------------------------------------------------------------------
  try {
    const invidiousType = type === "video"
      ? "video"
      : type === "playlist"
        ? "playlist"
        : type === "channel"
          ? "channel"
          : "all";

    const invidiousResults = await invidiousProvider.search(query, invidiousType);

    return {
      songs: invidiousResults.songs || [],
      albums: invidiousResults.albums || [],
      artists: invidiousResults.artists || [],
    };
  } catch (err) {
    console.warn("Invidious fallback also failed:", err);
    return { songs: [], albums: [], artists: [] };
  }
}

/**
 * Get all items in a playlist (used for album-track listing).
 * Tries the YouTube Data API first, falls back to Invidious.
 */
export async function getPlaylistItems(
  playlistId: string,
): Promise<import("@strumm/types").Song[]> {
  // Try YouTube Data API first
  try {
    const res = await fetch(`/api/playlist-items?id=${encodeURIComponent(playlistId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.success && json.data) {
        return json.data;
      }
    }
  } catch {
    // fall through
  }

  // Fallback to Invidious
  try {
    const items = await invidiousProvider.getPlaylistItems(playlistId);
    return items as import("@strumm/types").Song[];
  } catch {
    return [];
  }
}
