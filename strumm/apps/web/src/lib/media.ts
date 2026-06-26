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

  // Priority order: most reliable YouTube thumbnails first
  if (videoId && !videoId.startsWith("podcast-")) {
    const directUrls = [
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    ];

    // For hero (large) images, add optimized proxy URLs first (WebP, resized)
    if (hero) {
      candidates.push(
        ...directUrls.slice(0, 2).map((u) => getOptimizedArtworkUrl(u, 320)),
      );
    }

    // Always add direct URLs as fallback
    candidates.push(...directUrls);
  }

  // Fallback to API-provided thumbnail if available
  if (song?.thumbnail) {
    const thumb = song.thumbnail.startsWith("http://")
      ? song.thumbnail.replace("http://", "https://")
      : song.thumbnail;
    candidates.push(thumb);
  }

  // Additional fallbacks as a last resort
  if (videoId && !videoId.startsWith("podcast-")) {
    candidates.push(
      `https://img.youtube.com/vi/${videoId}/0.jpg`,
      `https://img.youtube.com/vi/${videoId}/1.jpg`,
    );
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function getBestArtwork(song?: Pick<Song, "videoId" | "thumbnail"> | null, hero?: boolean) {
  return getArtworkCandidates(song, hero)[0] || "";
}
