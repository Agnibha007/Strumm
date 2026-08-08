import { apiFetch } from "web/lib/api-client";
import type { Song } from "@strumm/types";

const PODCAST_PREFIX = "podcast-";

export function getPodcastEpisodeId(song?: Pick<Song, "videoId"> | null): string | null {
  if (!song?.videoId || !song.videoId.startsWith(PODCAST_PREFIX)) return null;
  return song.videoId.slice(PODCAST_PREFIX.length);
}

interface PodcastProgress {
  positionSeconds: number;
  durationSeconds: number;
}

export async function fetchPodcastProgress(episodeId: string): Promise<PodcastProgress> {
  try {
    return await apiFetch<PodcastProgress>(`/podcasts/progress/${encodeURIComponent(episodeId)}`);
  } catch {
    return { positionSeconds: 0, durationSeconds: 0 };
  }
}

export async function savePodcastProgress(
  episodeId: string,
  positionSeconds: number,
  durationSeconds: number,
): Promise<void> {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return;
  try {
    await apiFetch(`/podcasts/progress/${encodeURIComponent(episodeId)}`, {
      method: "PUT",
      body: JSON.stringify({
        positionSeconds: Math.max(0, Math.round(positionSeconds)),
        durationSeconds:
          Number.isFinite(durationSeconds) && durationSeconds > 0
            ? Math.round(durationSeconds)
            : 0,
      }),
    });
  } catch {
    // Best-effort; failures should never interrupt playback.
  }
}

export async function clearPodcastProgress(episodeId: string): Promise<void> {
  try {
    await apiFetch(`/podcasts/progress/${encodeURIComponent(episodeId)}`, {
      method: "DELETE",
    });
  } catch {
    // Best-effort.
  }
}
