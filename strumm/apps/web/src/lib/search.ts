/**
 * Search API client — resolves searches from the BROWSER via keyless public
 * Piped instances (no server egress to YouTube, no CORS issues), with a
 * same-origin /api/search fallback that is itself Piped-only.
 *
 * Primary path:  browser → Piped public instance (direct, open CORS)
 * Fallback path: browser → /api/search (Next.js, Piped-only)
 *
 * Requests to YouTube are never made from this app's servers — the browser
 * talks to Piped (a privacy-facing YouTube proxy) which performs the YouTube
 * request for it.
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
 * Resolves from the BROWSER via public Piped instances first (no server egress
 * to YouTube). If that yields nothing, falls back to the same-origin /api/search
 * route, which is itself Piped-only.
 */
export async function searchYouTube(
  opts: SearchOptions,
): Promise<SearchResults> {
  const { query, type } = opts;

  if (!query.trim()) {
    return { songs: [], albums: [], artists: [] };
  }

  const invidiousType = type === "video"
    ? "video"
    : type === "playlist"
      ? "playlist"
      : type === "channel"
        ? "channel"
        : "all";

  // -------------------------------------------------------------------
  // 1. Browser → Piped (direct, no server egress to YouTube)
  // -------------------------------------------------------------------
  try {
    const invidiousResults = await invidiousProvider.search(query, invidiousType);
    if (
      invidiousResults &&
      (invidiousResults.songs.length > 0 ||
        invidiousResults.albums.length > 0 ||
        invidiousResults.artists.length > 0)
    ) {
      return {
        songs: invidiousResults.songs || [],
        albums: invidiousResults.albums || [],
        artists: invidiousResults.artists || [],
      };
    }
  } catch (err) {
    console.warn("Piped search failed, falling back to /api/search:", err);
  }

  // -------------------------------------------------------------------
  // 2. Same-origin /api/search fallback (Piped-only)
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
    console.warn(`Search API returned HTTP ${res.status}, no Piped results available.`);
  } catch (err) {
    console.warn("Search API request failed:", err);
  }

  return { songs: [], albums: [], artists: [] };
}

/**
 * Get all items in a playlist (used for album-track listing).
 * Resolves from the browser via Piped; falls back to /api/playlist-items.
 */
export async function getPlaylistItems(
  playlistId: string,
): Promise<import("@strumm/types").Song[]> {
  // Browser → Piped first.
  try {
    const items = await invidiousProvider.getPlaylistItems(playlistId);
    if (items && items.length > 0) return items as import("@strumm/types").Song[];
  } catch {
    // fall through
  }

  // Same-origin fallback.
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
  return [];
}
