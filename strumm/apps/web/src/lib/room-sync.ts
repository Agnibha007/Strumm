import type { Song } from "@strumm/types";

export function buildRoomPlaybackQueue(currentTrack: Song | null | undefined, upcoming: unknown): Song[] {
  const queue = Array.isArray(upcoming)
    ? upcoming.filter((song): song is Song => !!song && typeof song === "object" && typeof (song as Song).videoId === "string" && !!(song as Song).videoId)
    : [];
  if (!currentTrack?.videoId) return queue;
  return [currentTrack, ...queue.filter((song) => song.videoId !== currentTrack.videoId)];
}

export function appendRoomQueueSong(queue: Song[], song: Song): Song[] {
  if (!song?.videoId || queue.some((entry) => entry.videoId === song.videoId)) return queue;
  return [...queue, song];
}

export function removeRoomQueueSong(queue: Song[], videoId: string): Song[] {
  return queue.filter((song) => song.videoId !== videoId);
}
