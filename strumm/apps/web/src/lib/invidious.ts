/**
 * Invidious API client — powers client-side search directly from the browser.
 *
 * The frontend talks to a public Invidious instance instead of proxying
 * search through the Strumm backend. This avoids the HF Spaces backend
 * being unable to reach Invidious/YouTube (which are blocked from cloud IPs).
 *
 * CORS strategy:
 *   1. Try the configured primary instance
 *   2. If that fails (CORS or network error), try fallback instances
 *   3. If all direct instances fail, try through a CORS proxy
 *   4. The working instance is cached for the session
 */

// ---------------------------------------------------------------------------
// Invidious instances to try (ordered by preference)
// ---------------------------------------------------------------------------

const PRIMARY_INSTANCE =
  process.env.NEXT_PUBLIC_INVIDIOUS_INSTANCE || "https://inv.nadeko.net";

const FALLBACK_INSTANCES: string[] = [
  "https://inv.nadeko.net",
  "https://invidious.jing.rocks",
  "https://invidious.snopyta.org",
  "https://yewtu.be",
  "https://vid.puffyan.us",
];

// CORS proxy to use as last resort
const CORS_PROXY = "https://corsproxy.io/?";

let _workingInstance: string | null = null;

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function videoToSong(v: any): import("@strumm/types").Song {
  const thumbs = v.videoThumbnails || [];
  const thumbUrl =
    thumbs.find((t: any) => t.quality === "medium")?.url ||
    thumbs.find((t: any) => t.quality === "hq720")?.url ||
    thumbs[0]?.url ||
    `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;

  return {
    videoId: v.videoId,
    title: v.title || "Untitled",
    artist: v.author || "Unknown Artist",
    thumbnail: thumbUrl,
    duration: v.lengthSeconds || 200,
  };
}

function playlistToAlbum(p: any) {
  return {
    id: p.playlistId,
    title: p.title || "Untitled",
    artist: p.author || "Unknown Artist",
    thumbnail: p.playlistThumbnail || "",
    year: "",
  };
}

function channelToArtist(c: any) {
  const thumbs = c.authorThumbnails || [];
  return {
    id: c.authorId,
    name: c.author || "Unknown",
    thumbnail: thumbs[thumbs.length - 1]?.url || "",
  };
}

// ---------------------------------------------------------------------------
// Fetch helper with CORS resilience
// ---------------------------------------------------------------------------

/**
 * Try to fetch from an Invidious endpoint across multiple instances + CORS proxy.
 *
 * Returns the raw parsed JSON (any shape) on success, or null if all attempts fail.
 * Callers are responsible for validating the response shape.
 */
async function fetchWithFallback(
  path: string,
  params: string,
): Promise<any | null> {
  // Build the list of URLs to try
  const urlsToTry: string[] = [];

  if (_workingInstance) {
    // Fast path: use the cached working instance
    urlsToTry.push(`${_workingInstance}${path}?${params}`);
  } else {
    // Try primary, then fallbacks, then CORS proxy
    const instances = [
      PRIMARY_INSTANCE,
      ...FALLBACK_INSTANCES.filter((i) => i !== PRIMARY_INSTANCE),
    ];
    for (const inst of instances) {
      urlsToTry.push(`${inst}${path}?${params}`);
    }
    // CORS proxy fallback wrapping the primary instance URL
    urlsToTry.push(
      `${CORS_PROXY}${encodeURIComponent(`${PRIMARY_INSTANCE}${path}?${params}`)}`,
    );
  }

  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json();

      // Cache the working instance for subsequent calls
      try {
        const u = new URL(url);
        _workingInstance = `${u.protocol}//${u.host}`;
      } catch {
        /* ignore */
      }

      return data; // return raw data — caller validates the shape
    } catch {
      // CORS error, network failure, or timeout — try next URL
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
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
 * Tries multiple Invidious instances + CORS proxy fallback so search works
 * from any deployment environment.
 */
export async function searchInvidious(
  opts: InvidiousSearchOptions,
): Promise<InvidiousSearchResults> {
  const { query, page } = opts;

  if (!query.trim()) {
    return { songs: [], albums: [], artists: [] };
  }

  const q = encodeURIComponent(query);
  const pg = page || 1;
  const baseParams = `q=${q}&page=${pg}`;

  // Run type-specific searches in parallel (each with its own fallback chain)
  const [videoData, playlistData, channelData] = await Promise.all([
    fetchWithFallback("/api/v1/search", `${baseParams}&type=video`),
    fetchWithFallback("/api/v1/search", `${baseParams}&type=playlist`),
    fetchWithFallback("/api/v1/search", `${baseParams}&type=channel`),
  ]);

  const songs: import("@strumm/types").Song[] = [];
  const albums: any[] = [];
  const artists: any[] = [];

  if (Array.isArray(videoData)) {
    for (const item of videoData) {
      if (item.type === "video" || item.videoId) {
        songs.push(videoToSong(item));
      }
    }
  }

  if (Array.isArray(playlistData)) {
    for (const item of playlistData) {
      if (item.type === "playlist" || item.playlistId) {
        albums.push(playlistToAlbum(item));
      }
    }
  }

  if (Array.isArray(channelData)) {
    for (const item of channelData) {
      if (item.type === "channel" || item.authorId) {
        artists.push(channelToArtist(item));
      }
    }
  }

  return { songs, albums, artists };
}

/**
 * Get full details for a single video (used by the song resolution page).
 * The /api/v1/videos/{id} endpoint returns a single video object.
 */
export async function getVideoDetails(
  videoId: string,
): Promise<import("@strumm/types").Song | null> {
  const data = await fetchWithFallback(
    `/api/v1/videos/${encodeURIComponent(videoId)}`,
    "",
  );
  if (data && data.videoId) {
    return videoToSong(data);
  }
  return null;
}

/**
 * Get all items in a playlist (used for album-track listing).
 * The /api/v1/playlists/{id} endpoint returns { videos: [...] }.
 */
export async function getPlaylistItems(
  playlistId: string,
): Promise<import("@strumm/types").Song[]> {
  const data = await fetchWithFallback(
    `/api/v1/playlists/${encodeURIComponent(playlistId)}`,
    "",
  );
  if (data && Array.isArray(data.videos)) {
    return data.videos.map(videoToSong);
  }
  return [];
}
