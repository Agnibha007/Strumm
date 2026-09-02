import { Song } from "@strumm/types";
import { apiUrl } from "web/lib/api";

export function getYouTubeIdFromThumbnail(url?: string) {
  if (!url) return "";
  const match = url.match(/\/vi\/([^/?#]+)/);
  return match?.[1] || "";
}

export function getSongVideoId(song?: Pick<Song, "videoId" | "thumbnail"> | null) {
  return song?.videoId || getYouTubeIdFromThumbnail(song?.thumbnail) || "";
}

/**
 * Return an optimized image URL through the backend's /image-proxy endpoint.
 * The backend will resize, convert to WebP, and aggressively cache the result.
 */
export function getOptimizedArtworkUrl(rawUrl: string, width: number): string {
  if (!rawUrl) return "";
  return apiUrl(`/image-proxy?url=${encodeURIComponent(rawUrl)}&w=${width}&quality=80`);
}

const ARTWORK_CACHE_LIMIT = 2000;
const artworkCandidatesCache = new Map<string, string[]>();

export function getArtworkCandidates(
  song?: Pick<Song, "videoId" | "thumbnail"> | null,
  hero?: boolean,
) {
  // Pure function of (videoId, thumbnail, hero) — memoize at module scope
  // instead of per-component useMemo (hooks are the forbidden pattern here;
  // see the SongArtwork note). Grids render dozens of tiles per frame, so this
  // avoids recomputing ~13 URLs per artwork on every render while remaining
  // bounded for a session.
  const videoId = getSongVideoId(song);
  const rawThumbnail = (song?.thumbnail || "").trim();
  const cacheKey = `${hero ? "h" : "n"}|${videoId}|${rawThumbnail}`;
  const cached = artworkCandidatesCache.get(cacheKey);
  if (cached) return cached;

  const songThumbnail = rawThumbnail.startsWith("http://")
    ? rawThumbnail.replace("http://", "https://")
    : rawThumbnail;
  const candidates: string[] = [];

  // The API-provided thumbnail is the only URL we *know* exists for this
  // track. Always list it FIRST so artwork is visible immediately (proxy →
  // raw), then speculative YouTube URLs serve as fallbacks.
  if (songThumbnail) {
    candidates.push(getOptimizedArtworkUrl(songThumbnail, hero ? 320 : 160));
    candidates.push(songThumbnail);
  }

  // Speculative YouTube thumbnail URLs for video tracks (most music videos
  // don't have maxresdefault, so keep these AFTER the guaranteed thumbnail).
  if (videoId && !videoId.startsWith("podcast-")) {
    // 16:9 thumbnails — no letterboxing, match video aspect ratio.
    // Use only one host per URL to avoid duplicates (i.ytimg.com and
    // img.youtube.com serve the same images).
    const hdUrls16_9 = [
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,      // 320x180 (16:9)
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,  // 1280x720 (16:9)
      `https://img.youtube.com/vi/${videoId}/0.jpg`,          // 1280x720 (16:9)
      `https://img.youtube.com/vi/${videoId}/1.jpg`,
      `https://img.youtube.com/vi/${videoId}/2.jpg`,
      `https://img.youtube.com/vi/${videoId}/3.jpg`,
    ];

    // 4:3 thumbnails — often have baked-in letterboxing (use as last resort)
    const hdUrls4_3 = [
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,      // 480x360 (4:3)
      `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,      // 640x480 (4:3)
    ];

    candidates.push(...hdUrls16_9);
    candidates.push(...hdUrls4_3);
  }

  const result = [...new Set(candidates.filter(Boolean))];
  if (artworkCandidatesCache.size >= ARTWORK_CACHE_LIMIT) {
    artworkCandidatesCache.clear();
  }
  artworkCandidatesCache.set(cacheKey, result);
  return result;
}

export function getBestArtwork(song?: Pick<Song, "videoId" | "thumbnail"> | null, hero?: boolean) {
  return getArtworkCandidates(song, hero)[0] || "";
}
