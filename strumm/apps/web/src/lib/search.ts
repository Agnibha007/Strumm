/**
 * Search API client — calls the Next.js API route /api/search which proxies
 * to the YouTube Data API v3 on the server side.
 *
 * No CORS issues — the browser calls its own origin (www.strumm.me/api/search).
 * No external dependencies — all proxying happens server-side on Vercel.
 *
 * This file only exposes the same `searchInvidious`, `getVideoDetails`, and
 * `getPlaylistItems` exports that the frontend already imports.  The name is
 * preserved for backward compatibility; the underlying implementation has
 * been migrated away from Invidious.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InvidiousSearchOptions {
  query: string;
  type?: "video" | "playlist" | "channel" | "all";
  page?: number;
  sort?: "relevance" | "views";
}

export interface InvidiousSearchResults {
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
export async function searchInvidious(
  opts: InvidiousSearchOptions,
): Promise<InvidiousSearchResults> {
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
 * Get full details for a single video (used by the song resolution page).
 * Proxied through a dedicated API route for consistency.
 */
export async function getVideoDetails(
  videoId: string,
): Promise<import("@strumm/types").Song | null> {
  try {
    const res = await fetch(`/api/video-details?id=${encodeURIComponent(videoId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.success && json.data) {
      return json.data;
    }
    return null;
  } catch {
    return null;
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
