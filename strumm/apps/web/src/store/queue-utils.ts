import { Song } from "@strumm/types";

export type RepeatMode = "none" | "all" | "one";

/**
 * Resolve the index of the next track to play.
 *
 * Extracted from usePlayerStore so the queue-advance rules can be unit
 * tested in isolation.
 *
 * @param onTrackEnd - true when this advance is triggered by a track
 *   reaching its natural end (or the queue being exhausted with repeat off),
 *   which results in playback stopping instead of looping the last track.
 */
export function resolveNextTrackIndex(
  queue: Song[],
  currentIndex: number,
  repeatMode: RepeatMode,
  isShuffle: boolean,
  onTrackEnd: boolean,
  shufflePlayedIds: string[] = []
): number | null {
  if (queue.length === 0) return null;

  if (isShuffle) {
    if (queue.length === 1) {
      return onTrackEnd && repeatMode !== "all" ? null : 0;
    }

    // Build set of videoIds already played in this shuffle round
    const playedSet = new Set(shufflePlayedIds);

    // Find indices for songs not yet played
    let eligibleIndices = queue
      .map((song, idx) => ({ song, idx }))
      .filter(({ song }) => !playedSet.has(song.videoId))
      .map(({ idx }) => idx);

    // If all songs have been played, reset and start a new round
    if (eligibleIndices.length === 0) {
      eligibleIndices = queue.map((_, idx) => idx);
    }

    // Remove current index to avoid playing the same song twice in a row
    const filtered = eligibleIndices.filter((idx) => idx !== currentIndex);

    if (filtered.length === 0) {
      // Only the current song is eligible (single-song queue handled above)
      return eligibleIndices[0];
    }

    return filtered[Math.floor(Math.random() * filtered.length)];
  }

  const nextIdx = currentIndex + 1;
  if (nextIdx >= queue.length) {
    if (repeatMode === "all") return 0;
    return onTrackEnd ? null : queue.length - 1;
  }
  return nextIdx;
}
