/**
 * Search API client — calls the Next.js API route /api/search which proxies
 * to the YouTube Data API v3 on the server side.
 *
 * No CORS issues — the browser calls its own origin (www.strumm.me/api/search).
 * No external dependencies — all proxying happens server-side on Vercel.
 *
 * This file exposes `searchYouTube` and `getPlaylistItems` exports that the
 * frontend uses to interact with the YouTube Data API v3 via Next.js API
 * route proxies.
 */

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
 * Calls the same-origin /api/search endpoint, which proxies to the YouTube
 * Data API v3 on the server side. No CORS issues.
 */
export async function searchYouTube(
  opts: SearchOptions,
): Promise<SearchResults> {
  const { query, type, page } = opts;

  if (!query.trim()) {
    return { songs: [], albums: [], artists: [] };
  }

  try {
    const params = new URLSearchParams({
      q: query,
      type: type || "all",
      page: String(page || 1),
    });
    const res = await fetch(`/api/search?${params.toString()}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn("Search API returned HTTP", res.status);
      return { songs: [], albums: [], artists: [] };
    }
    const json = await res.json();
    if (json.success && json.data) {
      return {
        songs: json.data.songs || [],
        albums: json.data.albums || [],
        artists: json.data.artists || [],
      };
    }
    return { songs: [], albums: [], artists: [] };
  } catch (err) {
    console.warn("Search request failed:", err);
    return { songs: [], albums: [], artists: [] };
  }
}

/**
 * Get all items in a playlist (used for album-track listing).
 * Proxied through a dedicated API route for consistency.
 */
export async function getPlaylistItems(
  playlistId: string,
): Promise<import("@strumm/types").Song[]> {
  try {
    const res = await fetch(`/api/playlist-items?id=${encodeURIComponent(playlistId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (json.success && json.data) {
      return json.data;
    }
    return [];
  } catch {
    return [];
  }
}
