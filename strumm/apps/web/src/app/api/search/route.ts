/**
 * Search API route — proxies search requests from the browser to Piped / Invidious.
 *
 * Runs on Vercel's Edge/Serverless infrastructure (not HF Spaces), so outbound
 * connections to external APIs work fine. No CORS issues since the browser
 * calls its own origin (www.strumm.me/api/search).
 *
 * Strategy:
 *   1. Try Piped API first (better CORS support, reliable instance)
 *   2. Fall back to Invidious if Piped fails
 *   3. Return unified response format
 */

import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Sources (ordered by preference)
// ---------------------------------------------------------------------------

const PIPED_API = "https://pipedapi.kavin.rocks";

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.jing.rocks",
  "https://invidious.snopyta.org",
  "https://yewtu.be",
];

// Timeout per fetch attempt (5 seconds)
const FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Extract videoId from Piped's url field (e.g. "/watch?v=dQw4w9WgXcQ") */
function videoIdFromPipedUrl(url: string): string {
  const m = url.match(/[?&]v=([^&]+)/);
  return m ? m[1] : url;
}

function pipedVideoToSong(item: any) {
  return {
    videoId: videoIdFromPipedUrl(item.url || ""),
    title: item.title || "Untitled",
    artist: item.uploaderName || "Unknown Artist",
    thumbnail: item.thumbnail || "",
    duration: item.duration || 0,
  };
}

function invidiousVideoToSong(item: any) {
  const thumbs = item.videoThumbnails || [];
  const thumbUrl =
    thumbs.find((t: any) => t.quality === "medium")?.url ||
    thumbs.find((t: any) => t.quality === "hq720")?.url ||
    thumbs[0]?.url ||
    `https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`;

  return {
    videoId: item.videoId,
    title: item.title || "Untitled",
    artist: item.author || "Unknown Artist",
    thumbnail: thumbUrl,
    duration: item.lengthSeconds || 200,
  };
}

function invidiousPlaylistToAlbum(item: any) {
  return {
    id: item.playlistId,
    title: item.title || "Untitled",
    artist: item.author || "Unknown Artist",
    thumbnail: item.playlistThumbnail || "",
    year: "",
  };
}

function invidiousChannelToArtist(item: any) {
  const thumbs = item.authorThumbnails || [];
  return {
    id: item.authorId,
    name: item.author || "Unknown",
    thumbnail: thumbs[thumbs.length - 1]?.url || "",
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<any | null> {
  const res = await fetchWithTimeout(url);
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Piped API search
// ---------------------------------------------------------------------------

async function searchPiped(
  q: string,
  filter: string,
): Promise<{ songs: any[] }> {
  const songs: any[] = [];

  // Piped filter: videos, channels, playlists, all
  const pipedFilter = filter === "all" ? "videos" : filter;
  const data = await fetchJson(
    `${PIPED_API}/search?q=${encodeURIComponent(q)}&filter=${pipedFilter}`,
  );

  if (data && Array.isArray(data.items)) {
    for (const item of data.items) {
      if (
        (filter === "all" || filter === "video") &&
        item.url?.startsWith("/watch")
      ) {
        songs.push(pipedVideoToSong(item));
      }
    }
  }

  return { songs };
}

// ---------------------------------------------------------------------------
// Invidious API search
// ---------------------------------------------------------------------------

async function searchInvidiousSource(
  q: string,
  type: "video" | "playlist" | "channel" | "all",
): Promise<{ songs: any[]; albums: any[]; artists: any[] }> {
  const songs: any[] = [];
  const albums: any[] = [];
  const artists: any[] = [];

  const typesToFetch =
    type === "all" ? (["video", "playlist", "channel"] as const) : [type];

  for (const t of typesToFetch) {
    for (const instance of INVIDIOUS_INSTANCES) {
      const data = await fetchJson(
        `${instance}/api/v1/search?q=${encodeURIComponent(q)}&type=${t}&page=1`,
      );

      if (Array.isArray(data)) {
        for (const item of data) {
          if (t === "video" && (item.type === "video" || item.videoId)) {
            songs.push(invidiousVideoToSong(item));
          } else if (
            t === "playlist" &&
            (item.type === "playlist" || item.playlistId)
          ) {
            albums.push(invidiousPlaylistToAlbum(item));
          } else if (
            t === "channel" &&
            (item.type === "channel" || item.authorId)
          ) {
            artists.push(invidiousChannelToArtist(item));
          }
        }
        // Found a working instance — move to next type
        break;
      }
      // Try next instance
    }
  }

  return { songs, albums, artists };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const type = searchParams.get("type") || "all";

  if (!q || !q.trim()) {
    return NextResponse.json(
      { success: false, error: "Query parameter 'q' is required." },
      { status: 400 },
    );
  }

  const validTypes = ["all", "video", "playlist", "channel"];
  const filter = validTypes.includes(type) ? type : "all";

  // 1. Try Piped API first
  const pipedResult = await searchPiped(q, filter);
  const hasPipedSongs = pipedResult.songs.length > 0;

  // 2. If Piped returned songs for video/all, try Invidious for playlists/channels too
  //    Otherwise, fall back to Invidious completely
  let invidiousResult: { songs: any[]; albums: any[]; artists: any[] } = { songs: [], albums: [], artists: [] };
  if (!hasPipedSongs || filter === "all" || filter === "playlist" || filter === "channel") {
    invidiousResult = await searchInvidiousSource(q, filter as any);
  }

  // Merge: Piped songs take priority, Invidious fills gaps
  const songs = pipedResult.songs.length > 0 ? pipedResult.songs : invidiousResult.songs;

  return NextResponse.json({
    success: true,
    data: {
      songs,
      albums: invidiousResult.albums,
      artists: invidiousResult.artists,
      source: hasPipedSongs ? "piped" : "invidious",
    },
  });
}
