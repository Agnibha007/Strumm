/**
 * YouTubeInnerTubeProvider — searches YouTube using youtubei.js, which
 * reverse‑engineers YouTube's private InnerTube API.  No API key needed.
 *
 * This provider runs **server‑side only** (Node.js).  It is the most reliable
 * zero‑cost search option because it talks to YouTube directly rather than
 * depending on third‑party proxy instances.
 *
 * Package: youtubei.js (https://github.com/LuanRT/YouTube.js)
 *
 * Fallback chain in /api/search:
 *   1. YouTubeInnerTubeProvider (no credentials, most reliable)
 *   2. YouTube Data API v3 (needs YOUTUBE_API_KEY)
 *   3. Piped / Invidious public instances (last resort)
 */

import type { SearchProvider, SearchResults, SongResult, AlbumResult, ArtistResult } from "./SearchProvider";
import { normalizeSong } from "../metadata/MetadataNormalizer";

// ---------------------------------------------------------------------------
// Lazy singleton — Innertube creation is somewhat expensive because it
// fetches YouTube's player script.  We create it once and reuse it.
// ---------------------------------------------------------------------------

let innertubeInstance: any = null;
let instancePromise: Promise<any> | null = null;
let lastCreatedAt = 0;
const INSTANCE_REFRESH_MS = 30 * 60 * 1000; // refresh every 30 minutes

async function getInnertube(): Promise<any> {
  const now = Date.now();

  // Return cached instance if still fresh
  if (innertubeInstance && now - lastCreatedAt < INSTANCE_REFRESH_MS) {
    return innertubeInstance;
  }

  // Deduplicate concurrent creation
  if (instancePromise) {
    return instancePromise;
  }

  instancePromise = (async () => {
    try {
      const { Innertube } = await import("youtubei.js");
      // Try with cache first; fall back to no cache if UniversalCache isn't available
      let instance: any;
      try {
        const { UniversalCache } = await import("youtubei.js");
        instance = await Innertube.create({ cache: new UniversalCache(false) });
      } catch {
        instance = await Innertube.create({});
      }
      innertubeInstance = instance;
      lastCreatedAt = Date.now();
      return instance;
    } catch (err) {
      console.error("YouTubeInnerTubeProvider: Failed to create Innertube instance:", err);
      throw err;
    } finally {
      instancePromise = null;
    }
  })();

  return instancePromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the best thumbnail URL from a youtubei.js thumbnail array. */
function pickThumbnail(thumbnails: any[] | undefined): string {
  if (!thumbnails || thumbnails.length === 0) return "";
  // Prefer the largest thumbnail
  return thumbnails[thumbnails.length - 1]?.url || thumbnails[0]?.url || "";
}

/** Extract text from a youtubei.js Text object or string. */
function toText(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val.toString === "function") return val.toString();
  if (val.text) return val.text;
  return String(val);
}

/** Convert a youtubei.js Video node to our SongResult format. */
function videoToSong(video: any): SongResult | null {
  try {
    const videoId = video.video_id;
    if (!videoId) return null;

    const title = toText(video.title);
    const artist = video.author?.name ? toText(video.author.name) : "Unknown Artist";
    const thumbnail = video.best_thumbnail?.url || pickThumbnail(video.thumbnails);
    const duration = video.duration?.seconds ?? 0;

    return normalizeSong(videoId, title, artist, thumbnail, duration);
  } catch {
    return null;
  }
}

/** Convert a youtubei.js Playlist node to our AlbumResult format. */
function playlistToAlbum(playlist: any): AlbumResult | null {
  try {
    const id = playlist.id;
    if (!id) return null;

    const title = toText(playlist.title);
    // Author can be Text or Author object
    const artist = playlist.author?.name
      ? toText(playlist.author.name)
      : toText(playlist.author);
    const thumbnail = pickThumbnail(playlist.thumbnails);

    return { id, title, artist, thumbnail, year: "" };
  } catch {
    return null;
  }
}

/** Convert a youtubei.js Channel node to our ArtistResult format. */
function channelToArtist(channel: any): ArtistResult | null {
  try {
    const id = channel.id;
    if (!id) return null;

    const name = channel.author?.name
      ? toText(channel.author.name)
      : toText(channel.short_byline || channel.long_byline) || "Unknown";

    const thumbnail = channel.author?.best_thumbnail?.url ||
      pickThumbnail(channel.author?.thumbnails);

    return { id, name, thumbnail };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Route a youtubei.js YTNode to the correct result bucket based on its type. */
function classifyYTNode(
  node: any,
  filterType: string,
  results: SearchResults
): void {
  if (!node) return;
  const t = node.type;
  if (t === "Video" && (filterType === "all" || filterType === "video")) {
    const song = videoToSong(node);
    if (song) results.songs.push(song);
  } else if (t === "Playlist" && (filterType === "all" || filterType === "playlist")) {
    const album = playlistToAlbum(node);
    if (album) results.albums.push(album);
  } else if (t === "Channel" && (filterType === "all" || filterType === "channel")) {
    const artist = channelToArtist(node);
    if (artist) results.artists.push(artist);
  }
}

/** Iterate over an array of YTNodes and classify each one. */
function classifyAll(
  nodes: any[] | undefined,
  filterType: string,
  results: SearchResults
): void {
  if (!nodes) return;
  for (const node of nodes) {
    classifyYTNode(node, filterType, results);
  }
}

// ---------------------------------------------------------------------------
// Warm-up — pre-initialize the Innertube instance on server startup so the
// first search request doesn't pay the cold-start penalty.
// ---------------------------------------------------------------------------

/** Trigger Innertube initialization early. Safe to call multiple times. */
export function warmUpInnertube(): void {
  getInnertube().catch((err) => {
    console.warn("YouTubeInnerTubeProvider: warm-up failed (will init on first request):", err);
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const youTubeInnerTubeProvider: SearchProvider = {
  name: "YouTube InnerTube",

  async search(q: string, type: string): Promise<SearchResults> {
    const results: SearchResults = { songs: [], albums: [], artists: [] };

    let yt: any;
    try {
      yt = await getInnertube();
    } catch (err) {
      console.error("YouTubeInnerTubeProvider: Innertube not available:", err);
      return results;
    }

    try {
      const search = await yt.search(q);

      if (!search?.results) {
        return results;
      }

      for (const item of search.results) {
        if (!item) continue;

        const itemType = item.type;

        // Unwrap RichItem — it wraps the actual content node
        if (itemType === "RichItem" && item.content) {
          classifyYTNode(item.content, type, results);
          continue;
        }

        // Unwrap Shelf — it contains a content array of items
        if (itemType === "Shelf") {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          classifyAll(content, type, results);
          continue;
        }

        // Handle ItemSection by flattening its contents
        if (itemType === "ItemSection") {
          classifyAll(item.contents, type, results);
          continue;
        }

        // Direct Video / Playlist / Channel results
        classifyYTNode(item, type, results);
      }

      // Limit results to 20 each to match previous behavior
      results.songs = results.songs.slice(0, 20);
      results.albums = results.albums.slice(0, 20);
      results.artists = results.artists.slice(0, 20);

      return results;
    } catch (err) {
      console.error("YouTubeInnerTubeProvider: Search failed:", err);
      return results;
    }
  },

  async getVideoDetails(videoId: string): Promise<SongResult | null> {
    try {
      const yt = await getInnertube();
      const info = await yt.getBasicInfo(videoId);
      if (!info?.basic_info) return null;

      const { basic_info } = info;
      return normalizeSong(
        videoId,
        basic_info.title ?? "Untitled",
        basic_info.author ?? "Unknown Artist",
        basic_info.thumbnail?.[0]?.url ?? "",
        basic_info.duration ?? 0,
      );
    } catch (err) {
      console.error("YouTubeInnerTubeProvider: getVideoDetails failed:", err);
      return null;
    }
  },

  async getPlaylistItems(playlistId: string): Promise<SongResult[]> {
    try {
      const yt = await getInnertube();
      const playlist = await yt.getPlaylist(playlistId);

      if (!playlist?.videos) return [];

      return playlist.videos
        .map((video: any) => {
          try {
            const vid = video.id || video.video_id;
            if (!vid) return null;
            return normalizeSong(
              vid,
              toText(video.title),
              video.author?.name ? toText(video.author.name) : "Unknown Artist",
              pickThumbnail(video.thumbnails),
              video.duration?.seconds ?? 0,
            );
          } catch {
            return null;
          }
        })
        .filter(Boolean) as SongResult[];
    } catch (err) {
      console.error("YouTubeInnerTubeProvider: getPlaylistItems failed:", err);
      return [];
    }
  },
};
