import { Song } from "@strumm/types";

export function getYouTubeIdFromThumbnail(url?: string) {
  if (!url) return "";
  const match = url.match(/\/vi\/([^/?#]+)/);
  return match?.[1] || "";
}

export function getSongVideoId(song?: Pick<Song, "videoId" | "thumbnail"> | null) {
  return song?.videoId || getYouTubeIdFromThumbnail(song?.thumbnail) || "";
}

export function getArtworkCandidates(song?: Pick<Song, "videoId" | "thumbnail"> | null) {
  const videoId = getSongVideoId(song);
  const candidates: string[] = [];

  // Priority order: most reliable YouTube thumbnails first
  if (videoId && !videoId.startsWith("podcast-")) {
    candidates.push(
      // Most reliable: hqdefault exists for virtually every YouTube video
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      // Second best: mqdefault also widely available
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      // Less reliable but higher quality
      `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
      // Rarely exists but best quality
      `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    );
  }

  // Fallback to API-provided thumbnail if available
  if (song?.thumbnail) {
    // Force HTTPS to avoid mixed content
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

export function getBestArtwork(song?: Pick<Song, "videoId" | "thumbnail"> | null) {
  return getArtworkCandidates(song)[0] || "";
}
