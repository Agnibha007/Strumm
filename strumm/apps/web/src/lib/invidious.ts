/**
 * Invidious API client — powers client-side search directly from the browser.
 *
 * The frontend talks to a public Invidious instance instead of proxying
 * search through the Strumm backend. This keeps backend costs low and
 * search fast (no server hop).
 */

const INVIDIOUS_INSTANCE =
  process.env.NEXT_PUBLIC_INVIDIOUS_INSTANCE ||
  "https://inv.nadeko.net";

/**
 * Map an Invidious video result to the Song shape used throughout the app.
 */
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

/**
 * Map an Invidious playlist result to the Album shape.
 */
function playlistToAlbum(p: any) {
  return {
    id: p.playlistId,
    title: p.title || "Untitled",
    artist: p.author || "Unknown Artist",
    thumbnail: p.playlistThumbnail || "",
    year: "",
  };
}

/**
 * Map an Invidious channel result to the Artist shape.
 */
function channelToArtist(c: any) {
  const thumbs = c.authorThumbnails || [];
  return {
    id: c.authorId,
    name: c.author || "Unknown",
    thumbnail: thumbs[thumbs.length - 1]?.url || "",
  };
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
 * Makes up to 3 parallel requests, one per content type, so the UI can
 * display categorised results just like the old backend did.
 */
export async function searchInvidious(
  opts: InvidiousSearchOptions,
): Promise<InvidiousSearchResults> {
  const { query, page } = opts;

  if (!query.trim()) {
    return { songs: [], albums: [], artists: [] };
  }

  const base = `${INVIDIOUS_INSTANCE}/api/v1/search`;
  const baseParams = `q=${encodeURIComponent(query)}&page=${page || 1}`;

  // Run type-specific searches in parallel
  const [videoRes, playlistRes, channelRes] = await Promise.allSettled([
    fetch(`${base}?${baseParams}&type=video`),
    fetch(`${base}?${baseParams}&type=playlist`),
    fetch(`${base}?${baseParams}&type=channel`),
  ]);

  const songs: import("@strumm/types").Song[] = [];
  const albums: any[] = [];
  const artists: any[] = [];

  // Parse video results → Songs
  if (videoRes.status === "fulfilled" && videoRes.value.ok) {
    try {
      const data = await videoRes.value.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.type === "video" || item.videoId) {
            songs.push(videoToSong(item));
          }
        }
      }
    } catch { /* skip malformed response */ }
  }

  // Parse playlist results → Albums
  if (playlistRes.status === "fulfilled" && playlistRes.value.ok) {
    try {
      const data = await playlistRes.value.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.type === "playlist" || item.playlistId) {
            albums.push(playlistToAlbum(item));
          }
        }
      }
    } catch { /* skip malformed response */ }
  }

  // Parse channel results → Artists
  if (channelRes.status === "fulfilled" && channelRes.value.ok) {
    try {
      const data = await channelRes.value.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.type === "channel" || item.authorId) {
            artists.push(channelToArtist(item));
          }
        }
      }
    } catch { /* skip malformed response */ }
  }

  return { songs, albums, artists };
}

/**
 * Get full details for a single video (used by the song resolution page).
 */
export async function getVideoDetails(videoId: string): Promise<import("@strumm/types").Song | null> {
  try {
    const res = await fetch(
      `${INVIDIOUS_INSTANCE}/api/v1/videos/${encodeURIComponent(videoId)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return videoToSong(data);
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
    const res = await fetch(
      `${INVIDIOUS_INSTANCE}/api/v1/playlists/${encodeURIComponent(playlistId)}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    const videos = data.videos || [];
    return videos.map(videoToSong);
  } catch {
    return [];
  }
}
