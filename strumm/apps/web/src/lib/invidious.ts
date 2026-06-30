/**
 * Invidious API client — powers search via the Strumm backend proxy.
 *
 * The frontend talks to its own backend endpoint (/search/proxy) instead of
 * calling a public Invidious instance directly. This avoids CORS issues
 * that arise when the browser tries to fetch from a third-party origin
 * that doesn't set Access-Control-Allow-Origin headers.
 */

import { apiUrl } from "web/lib/api";

// ---------------------------------------------------------------------------
// Public types (same shape as before for backward compatibility)
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
 * Calls the Strumm backend's /search/proxy endpoint, which proxies the
 * request to Invidious server-side and returns categorised results.
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
    const res = await fetch(apiUrl(`/search/proxy?${params.toString()}`));
    if (!res.ok) {
      console.warn("Search proxy returned HTTP", res.status);
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
    console.warn("Search proxy request failed:", err);
    return { songs: [], albums: [], artists: [] };
  }
}

/**
 * Get full details for a single video (used by the song resolution page).
 */
export async function getVideoDetails(videoId: string): Promise<import("@strumm/types").Song | null> {
  try {
    const res = await fetch(apiUrl(`/search/proxy/video/${encodeURIComponent(videoId)}`));
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
 */
export async function getPlaylistItems(
  playlistId: string,
): Promise<import("@strumm/types").Song[]> {
  try {
    const res = await fetch(apiUrl(`/search/proxy/playlist/${encodeURIComponent(playlistId)}`));
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
