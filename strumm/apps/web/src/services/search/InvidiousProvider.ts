/**
 * InvidiousProvider — resolves YouTube search / playlist / stream metadata.
 *
 * THIN CLIENT over the Strumm backend proxy.
 *
 * All YouTube metadata resolution now happens SERVER-SIDE (Strumm FastAPI →
 * YouTube Music / Piped fallbacks) and is exposed to this app via the
 * same-origin `/proxy` rewrite. The browser never calls public Piped instances
 * directly (those fail with CORS / 403 / 525 from arbitrary origins).
 *
 * The backend returns Piped-compatible payloads, so this module's mapping,
 * picking, and candidate shapes are unchanged — only the transport target
 * moved from `pipedapi.*` to `/proxy/yt/*`.
 *
 * SearchProvider contract (search / getPlaylistItems) and the
 * `fetchPipedStreams` + `PipedStreamsData` exports preserve the prior public
 * surface, so callers (search box, playlist import, direct-audio/radio) are
 * unaffected.
 */

import type { SearchProvider, SearchResults, SongResult, AlbumResult, ArtistResult } from "./SearchProvider";
import { normalizeSong } from "../metadata/MetadataNormalizer";
import { decodeHtml, apiUrl, API_ORIGIN } from "web/lib/api";

// ---------------------------------------------------------------------------
// Piped instances — handled server-side; this module only proxies to the API.
// ---------------------------------------------------------------------------

/** Kept for backward compatibility (the instance list now lives server-side). */
export function refreshInstances(): void {
  /* no-op — Piped instance selection is managed by the backend. */
}

// ---------------------------------------------------------------------------
// Proxy client
// ---------------------------------------------------------------------------

/**
 * Build the backend URL for a `/yt` path.
 *
 * In the BROWSER we use the same-origin relative `/proxy/...` URL (rewritten
 * by next.config.ts so there is no cross-origin call). Inside Next.js route
 * handlers / server context the `/proxy` rewrite is NOT applied, so we build
 * an absolute URL against the configured API origin instead.
 */
function backendUrl(path: string): string {
  const isServer =
    typeof window === "undefined" ||
    typeof document === "undefined";
  if (isServer) return `${API_ORIGIN}${path}`;
  return apiUrl(path);
}

/**
 * GET a backend `/yt` proxy endpoint and return its `data` payload (Piped-
 * shaped). Throws on network / HTTP error so callers can fall back.
 */
async function proxyGet<T = any>(path: string, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(backendUrl(path), {
      signal: controller.signal,
      credentials: "include",
    });
    if (!res.ok) throw new Error(`YouTube proxy HTTP ${res.status} for ${path}`);
    const json = (await res.json()) as { success?: boolean; data?: unknown };
    if (!json || json.success === false) {
      throw new Error(`YouTube proxy request failed for ${path}`);
    }
    return json?.data as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Piped /streams — shared by direct-audio and browser-side radio/metadata
// ---------------------------------------------------------------------------

/** A single Piped stream info response (``GET /streams/{id}``). */
export interface PipedStreamsData {
  title?: string;
  duration?: number;
  uploader?: string;
  thumbnailUrl?: string;
  audioStreams?: Array<{ url?: string; mimeType?: string; bitrate?: number }>;
  videoStreams?: Array<{
    url?: string;
    mimeType?: string;
    bitrate?: number;
    videoOnly?: boolean;
  }>;
  relatedStreams?: Array<{
    url?: string;
    type?: string;
    title?: string;
    uploaderName?: string;
    thumbnail?: string;
    duration?: number;
  }>;
}

/**
 * Fetch ``/streams/{videoId}`` metadata from the backend proxy, returning the
 * Piped-shaped payload or ``null`` when the backend can't resolve it.
 */
export async function fetchPipedStreams(videoId: string): Promise<PipedStreamsData | null> {
  if (!videoId) return null;
  try {
    const data = await proxyGet(`/yt/streams/${encodeURIComponent(videoId)}`, 12_000);
    return (data as PipedStreamsData) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Piped API response types
// ---------------------------------------------------------------------------

interface PipedStreamItem {
  url: string;
  type: "stream";
  title: string;
  thumbnail: string;
  uploaderName: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  uploadedDate: string;
  shortDescription: string;
  duration: number;
  views: number;
  uploaded: number;
  uploaderVerified: boolean;
  isShort: boolean;
}

interface PipedChannelItem {
  url: string;
  type: "channel";
  name: string;
  thumbnail: string;
  subscribers: number;
  description: string;
  videos: number;
}

interface PipedPlaylistItem {
  url: string;
  type: "playlist";
  name: string;
  thumbnail: string;
  uploaderName: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  videos: number;
}

/** Backend `/yt/search` returns Piped-shaped items under `data.items`. */
interface PipedSearchResponse {
  items: Array<PipedStreamItem | PipedChannelItem | PipedPlaylistItem>;
  nextpage?: string;
}

/** Backend `/yt/playlist/{id}` returns Piped-shaped tracks under `relatedStreams`. */
interface PipedPlaylistDetail {
  name?: string;
  relatedStreams?: Array<PipedStreamItem>;
  nextpage?: string;
  videos?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

function extractChannelId(url: string): string | null {
  const m = url.match(/\/channel\/([^/?&]+)/);
  return m ? m[1] : null;
}

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
  name: "YouTube (Strumm backend proxy)",

  async search(q: string, type: string): Promise<SearchResults> {
    const backendType =
      type === "videos" || type === "video" ? "song"
        : type === "playlists" || type === "playlist" ? "playlist"
          : type === "channels" || type === "channel" ? "channel"
            : "all";

    const params = new URLSearchParams({ q, type: backendType });
    const data = await proxyGet<PipedSearchResponse>(`/yt/search?${params.toString()}`, 14_000);

    const results: SearchResults = { songs: [], albums: [], artists: [] };
    if (data && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (item.type === "stream" && (type === "all" || type === "video" || type === "videos")) {
          const song = pipedStreamToSong(item);
          if (song) results.songs.push(song);
        } else if (item.type === "playlist" && (type === "all" || type === "playlist" || type === "playlists")) {
          const album = pipedPlaylistToAlbum(item);
          if (album) results.albums.push(album);
        } else if (item.type === "channel" && (type === "all" || type === "channel" || type === "channels")) {
          const artist = pipedChannelToArtist(item);
          if (artist) results.artists.push(artist);
        }
      }
    }

    return results;
  },

  async getVideoDetails(_videoId: string): Promise<SongResult | null> {
    return null;
  },

  async getPlaylistItems(playlistId: string): Promise<SongResult[]> {
    const items: SongResult[] = [];
    const encoded = encodeURIComponent(playlistId);

    // The backend proxy returns the full track list in one page (Piped's
    // `relatedStreams` shape); no client-side pagination walking is needed.
    let guard = 0;
    let nextpage: string | undefined;
    do {
      const data = await proxyGet<PipedPlaylistDetail>(`/yt/playlist/${encoded}`, 14_000);
      if (!data) break;

      const batch = (data.relatedStreams || [])
        .map((v) => {
          const videoId = extractVideoId(v.url);
          if (!videoId) return null;
          return normalizeSong(
            videoId,
            decodeHtml(v.title) ?? "Untitled",
            decodeHtml(v.uploaderName) ?? "Unknown Artist",
            v.thumbnail,
            v.duration ?? 0,
          );
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({
          videoId: s.videoId,
          title: s.title,
          artist: s.artist,
          thumbnail: s.thumbnail,
          duration: s.duration,
        }));
      items.push(...batch);

      nextpage = data.nextpage;
      guard++;
    } while (nextpage && guard < 50);

    return items;
  },
};