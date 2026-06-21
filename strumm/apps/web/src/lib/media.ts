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

  if (song?.thumbnail) {
    candidates.push(song.thumbnail);
  }

  if (videoId && !videoId.startsWith("podcast-")) {
    candidates.push(
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${videoId}/0.jpg`,
    );
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function getBestArtwork(song?: Pick<Song, "videoId" | "thumbnail"> | null) {
  return getArtworkCandidates(song)[0] || "";
}
