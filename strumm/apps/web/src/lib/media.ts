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

const YT_IMAGE_HOSTS = [
  "i.ytimg.com",
  "img.youtube.com",
  "ytimg.com",
  "lh3.googleusercontent.com",
  "yt3.googleusercontent.com",
  "yt3.ggpht.com",
];

// Channel-avatar hosts. A stored thumbnail on these is the uploader's profile
// picture, not the track's artwork — never surface it as song art. Prefer the
// videoId-generated ytimg thumbnails instead.
const CHANNEL_AVATAR_HOSTS = ["yt3.googleusercontent.com", "yt3.ggpht.com"];

function isChannelAvatarHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CHANNEL_AVATAR_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function isYouTubeImageHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return YT_IMAGE_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/**
 * Quality tiers for artwork rendering. Use the tier that matches the
 * *displayed* size of the image so small thumbnails don't waste bandwidth
 * and large artwork looks crisp.
 *
 *   FULL      – fullscreen player, share-page hero  (≥ 320 px)
 *   HIGH      – playlist hero, discovery grids       (≈ 192–224 px)
 *   MEDIUM    – stats, replay, search, medium items  (≈ 128–160 px)
 *   LOW       – miniplayer, queue, sidebar           (≈ 64–96 px)
 *   THUMBNAIL – tiny avatar-sized thumbs             (≤ 48 px)
 */
export const ARTWORK_QUALITY_FULL = 85;
export const ARTWORK_QUALITY_HIGH = 80;
export const ARTWORK_QUALITY_MEDIUM = 75;
export const ARTWORK_QUALITY_LOW = 70;
export const ARTWORK_QUALITY_THUMBNAIL = 65;

/**
 * The API server's egress IP is blocked by YouTube's CDN, so /image-proxy
 * cannot fetch YouTube-hosted thumbnails (they'd 502 -> blank art). YouTube
 * images load fine straight from the BROWSER, so we skip the proxy for those
 * hosts and use the raw URL directly. The proxy is kept only for non-YouTube
 * image sources (Spotify/CDN-hosted art).
 */
export function getOptimizedArtworkUrl(rawUrl: string, width: number, quality: number = ARTWORK_QUALITY_MEDIUM): string {
  if (!rawUrl) return "";
  if (isYouTubeImageHost(rawUrl)) return rawUrl;
  return apiUrl(`/image-proxy?url=${encodeURIComponent(rawUrl)}&w=${width}&quality=${quality}`);
}

const ARTWORK_CACHE_LIMIT = 2000;
const artworkCandidatesCache = new Map<string, string[]>();

export function getArtworkCandidates(
  song?: Pick<Song, "videoId" | "thumbnail"> | null,
  hero?: boolean,
  quality: number = ARTWORK_QUALITY_MEDIUM,
) {
  // Pure function of (videoId, thumbnail, hero, quality) — memoize at module
  // scope instead of per-component useMemo (hooks are the forbidden pattern
  // here; see the SongArtwork note). Grids render dozens of tiles per frame,
  // so this avoids recomputing ~13 URLs per artwork on every render while
  // remaining bounded for a session.
  const videoId = getSongVideoId(song);
  const rawThumbnail = (song?.thumbnail || "").trim();
  const cacheKey = `${hero ? "h" : "n"}|${videoId}|${rawThumbnail}|${quality}`;
  const cached = artworkCandidatesCache.get(cacheKey);
  if (cached) return cached;

  const songThumbnail = rawThumbnail.startsWith("http://")
    ? rawThumbnail.replace("http://", "https://")
    : rawThumbnail;
  const candidates: string[] = [];

  // The API-provided thumbnail is the only URL we *know* exists for this
  // track. Always list it FIRST so artwork is visible immediately (YouTube-
  // hosted thumbnails load directly from the browser — the server proxy is
  // YouTube-CDN-blocked — non-YouTube sources go through the optimizing
  // proxy), then speculative YouTube URLs serve as fallbacks.
  // Exception: a stored thumbnail on a channel-avatar host (yt3.googleusercontent
  // /yt3.ggpht.com) is the uploader's profile picture, not the track's artwork —
  // skip it so the videoId-generated ytimg thumbnails lead.
  if (songThumbnail && !isChannelAvatarHost(songThumbnail)) {
    const first = getOptimizedArtworkUrl(songThumbnail, hero ? 320 : 160, quality);
    candidates.push(first);
    // For non-YouTube hosts the proxy is the optimized form; for YouTube hosts
    // getOptimizedArtworkUrl already returns the raw URL, so don't duplicate.
    if (!isYouTubeImageHost(songThumbnail)) {
      candidates.push(songThumbnail);
    }
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

export function getBestArtwork(
  song?: Pick<Song, "videoId" | "thumbnail"> | null,
  hero?: boolean,
  quality: number = ARTWORK_QUALITY_MEDIUM,
) {
  return getArtworkCandidates(song, hero, quality)[0] || "";
}
