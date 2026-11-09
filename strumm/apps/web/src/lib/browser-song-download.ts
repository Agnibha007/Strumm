import type { Song } from "@strumm/types";
import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

type DownloadProgress = (percent: number | null) => void;
type AudioStream = { url?: string; mimeType?: string; bitrate?: number; videoOnly?: boolean };
type StreamResponse = {
  success?: boolean;
  data?: { audioStreams?: AudioStream[]; videoStreams?: AudioStream[] };
};
type DirectAudioResponse = {
  success?: boolean;
  data?: { audioUrl?: string; mimeType?: string };
  error?: string;
};

function pickAudioStream(data: StreamResponse["data"]): AudioStream | null {
  const audioOnly = (data?.audioStreams || []).filter((stream) =>
    typeof stream.url === "string" && /^https?:\/\//i.test(stream.url),
  );
  const combined = (data?.videoStreams || []).filter((stream) =>
    !stream.videoOnly &&
    typeof stream.url === "string" &&
    /^https?:\/\//i.test(stream.url) &&
    (!stream.mimeType || ["audio/mp4", "video/mp4"].includes(stream.mimeType.split(";")[0].toLowerCase())),
  );
  const candidates = audioOnly.length ? audioOnly : combined;
  return candidates.sort((a, b) => {
    const mimeA = (a.mimeType || "").toLowerCase();
    const mimeB = (b.mimeType || "").toLowerCase();
    const scoreA = (mimeA.includes("audio/mp4") ? 1_000_000 : 0) + (Number(a.bitrate) || 0);
    const scoreB = (mimeB.includes("audio/mp4") ? 1_000_000 : 0) + (Number(b.bitrate) || 0);
    return scoreB - scoreA;
  })[0] || null;
}

async function resolveAudioSource(videoId: string, signal: AbortSignal) {
  try {
    const response = await authFetch(apiUrl(`/yt/streams/${encodeURIComponent(videoId)}`), { signal });
    if (response.ok) {
      const payload = (await response.json()) as StreamResponse;
      const stream = payload.success ? pickAudioStream(payload.data) : null;
      if (stream?.url) return { audioUrl: stream.url, mimeType: stream.mimeType || "audio/mp4" };
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }

  const response = await authFetch(apiUrl(`/play/${encodeURIComponent(videoId)}`), { signal });
  if (!response.ok) {
    throw new Error(`The audio source could not be resolved (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as DirectAudioResponse;
  if (!payload.success || !payload.data?.audioUrl) {
    throw new Error(payload.error || "No downloadable audio source is available for this track.");
  }
  return { audioUrl: payload.data.audioUrl, mimeType: payload.data.mimeType || "audio/mp4" };
}

export async function downloadSongInBrowser(
  song: Pick<Song, "videoId" | "title">,
  signal: AbortSignal,
  onProgress: DownloadProgress,
): Promise<{ blob: Blob; mimeType: string; audioUrl: string; sourceProvider: "direct" }> {
  if (!YOUTUBE_ID_PATTERN.test(song.videoId)) {
    throw new Error("This track does not have a valid YouTube video ID.");
  }

  const source = await resolveAudioSource(song.videoId, signal);
  const storage = typeof navigator !== "undefined" && navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => null)
    : null;
  if (
    storage?.quota !== undefined &&
    storage.usage !== undefined &&
    storage.quota - storage.usage < 1024 * 1024
  ) {
    throw new Error("There is not enough browser storage. Remove an old download and try again.");
  }

  const audioResponse = await authFetch(
    apiUrl(`/audio-proxy?url=${encodeURIComponent(source.audioUrl)}`),
    { method: "GET", signal },
  );
  if (!audioResponse.ok || !audioResponse.body) {
    throw new Error(`The audio stream could not be downloaded (HTTP ${audioResponse.status}).`);
  }

  const mimeType = (audioResponse.headers.get("content-type") || source.mimeType || "audio/mp4")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith("audio/") && mimeType !== "video/mp4") {
    throw new Error("The source returned an unsupported audio format.");
  }

  const rawLength = audioResponse.headers.get("content-length");
  const expectedLength = rawLength ? Number(rawLength) : null;
  if (expectedLength && expectedLength > MAX_DOWNLOAD_BYTES) {
    throw new Error("This track is larger than the 500 MiB download limit.");
  }

  const reader = audioResponse.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      received += result.value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error("This track is larger than the 500 MiB download limit.");
      }
      const chunkCopy = new Uint8Array(result.value.byteLength);
      chunkCopy.set(result.value);
      chunks.push(chunkCopy.buffer);
      onProgress(expectedLength ? Math.min(100, Math.round((received / expectedLength) * 100)) : null);
    }
  } finally {
    reader.releaseLock();
  }

  if (!received) throw new Error("The source returned an empty audio file.");
  const normalizedMime = mimeType === "video/mp4" ? "audio/mp4" : mimeType;
  return {
    blob: new Blob(chunks, { type: normalizedMime }),
    mimeType: normalizedMime,
    audioUrl: source.audioUrl,
    sourceProvider: "direct",
  };
}
