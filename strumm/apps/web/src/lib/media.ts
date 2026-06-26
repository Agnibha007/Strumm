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

export function getArtworkCandidates(
  song?: Pick<Song, "videoId" | "thumbnail"> | null,
  hero?: boolean,
) {
  const videoId = getSongVideoId(song);
  const candidates: string[] = [];

  // Priority order: 16:9 thumbnails first (no letterboxing), then fallbacks
  if (videoId && !videoId.startsWith("podcast-")) {
    // 16:9 thumbnails - no letterboxing, match video aspect ratio
    const hdUrls16_9 = [
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,  // 1280x720 (16:9)
      `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,      // 320x180 (16:9)
      `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/0.jpg`,          // 1280x720 (16:9)
      `https://img.youtube.com/vi/${videoId}/1.jpg`,          // 1280x720 (16:9)
      `https://img.youtube.com/vi/${videoId}/2.jpg`,
      `https://img.youtube.com/vi/${videoId}/3.jpg`,
    ];

    // 4:3 thumbnails - often have baked-in letterboxing (use as fallback)
    const hdUrls4_3 = [
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,      // 480x360 (4:3)
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,      // 640x480 (4:3)
    ];

    // For hero (large) images, add optimized proxy URLs first (WebP, resized)
    if (hero) {
      candidates.push(
        ...hdUrls16_9.slice(0, 2).map((u) => getOptimizedArtworkUrl(u, 320)),
      )
    }

    // Prioritize 16:9 thumbnails (no letterboxing)
    candidates.push(...hdUrls16_9);
    // Then 4:3 as fallback
    candidates.push(...hdUrls4_3);
  }

  // Fallback to API-provided thumbnail if available
  if (song?.thumbnail) {
    const thumb = song.thumbnail.startsWith("http://")
      ? song.thumbnail.replace("http://", "https://")
      : song.thumbnail;
    candidates.push(thumb);
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function getBestArtwork(song?: Pick<Song, "videoId" | "thumbnail"> | null, hero?: boolean) {
  return getArtworkCandidates(song, hero)[0] || "";
}
