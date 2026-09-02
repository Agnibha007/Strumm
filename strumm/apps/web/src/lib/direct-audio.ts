import { apiUrl } from "web/lib/api";
import { fetchPipedStreams } from "web/services/search/InvidiousProvider";
import type { PipedStreamsData } from "web/services/search/InvidiousProvider";

export interface DirectAudioData {
  videoId: string;
  audioUrl: string;
  mimeType?: string;
  title?: string;
  duration?: number;
}

interface DirectAudioResponse {
  success: boolean;
  data?: DirectAudioData;
  error?: string;
}

const CACHE_TTL_MS = 45 * 60 * 1000;
// A track that failed to resolve (e.g. YouTube bot-blocking every source) is
// remembered so we don't re-probe Piped + the server for the same videoId on
// the next pre-resolve / lock-screen tick. Short enough that a blocked track
// gets retried once the block clears, long enough to keep playback snappy when
// many tracks are blocked at once.
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const cache = new Map<string, { url: string; at: number }>();
// True when we already know this video has no resolvable direct audio.
const negativeCache = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();

export function getCachedDirectAudioUrl(videoId: string): string | null {
  const entry = cache.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(videoId);
    return null;
  }
  return entry.url;
}

function cacheDirectAudioUrl(videoId: string, url: string) {
  cache.set(videoId, { url, at: Date.now() });
  negativeCache.delete(videoId);
}

function isNegativeCached(videoId: string): boolean {
  const at = negativeCache.get(videoId);
  if (at === undefined) return false;
  if (Date.now() - at > NEGATIVE_CACHE_TTL_MS) {
    negativeCache.delete(videoId);
    return false;
  }
  return true;
}

function cacheNoDirectAudio(videoId: string) {
  negativeCache.set(videoId, Date.now());
}

/**
 * Resolve a direct audio URL for background / lock-screen playback.
 *
 * The URL is resolved from the BROWSER first: it queries public Piped
 * instances (`/streams/{id}`), which serve a playable MP4/audio URL with open
 * CORS — no server round-trip and unaffected by the API host's egress IP
 * being blocked by YouTube. Only if every browser-side path fails do we fall
 * back to the server's `/play/{id}`.
 *
 * The result is memoized client-side for 45 minutes. Concurrent calls for the
 * same video share one request (in-flight dedupe). Returns null when the track
 * has no direct audio (e.g. sign-in required) — callers silently fall back to
 * the YouTube iframe.
 */
export async function resolveDirectAudioUrl(videoId: string): Promise<string | null> {
  if (!videoId) return null;

  const cached = getCachedDirectAudioUrl(videoId);
  if (cached) return cached;

  // A recent failed resolution (bot-block) returns immediately instead of
  // re-probing every source for the same video.
  if (isNegativeCached(videoId)) return null;

  const inProgress = inflight.get(videoId);
  if (inProgress) return inProgress;

  const promise = resolveAudio(videoId);
  inflight.set(videoId, promise);
  promise.finally(() => inflight.delete(videoId));
  return promise;
}

async function resolveAudio(videoId: string): Promise<string | null> {
  // 1. Browser-side: Piped /streams (no server egress to YouTube).
  const piped = await fetchPipedAudio(videoId);
  if (piped) {
    cacheDirectAudioUrl(videoId, piped);
    return piped;
  }

  // 2. Fall back to the server /play endpoint.
  const direct = await fetchDirectAudio(videoId);
  if (direct) return direct;

  // No source could serve this track (e.g. YouTube bot-blocking every egress).
  // Remember it briefly so repeated pre-resolves don't hammer the sources.
  cacheNoDirectAudio(videoId);
  return null;
}

// ---------------------------------------------------------------------------
// Browser-side Piped audio extraction
// ---------------------------------------------------------------------------

function isPlayableUrl(u: string | undefined): u is string {
  return typeof u === "string" && u.trim().length > 0;
}

/** Normalize a MIME sub-type to a container we can classify. */
function extFromMime(mime: string | undefined): string {
  const ext = (mime ?? "").split("/")[1]?.split(";")[0].toLowerCase() ?? "";
  if (["m4a", "mp4", "webm", "ogg", "opus", "aac"].includes(ext)) return ext;
  return "mp4";
}

function pickPipedAudioStream(data: PipedStreamsData): string | null {
  // 1. Prefer a dedicated audio-only stream.
  let bestAudio: { score: number; url: string } | null = null;
  for (const s of data.audioStreams ?? []) {
    if (!isPlayableUrl(s.url)) continue;
    const ext = extFromMime(s.mimeType ?? "");
    const score = (Number(s.bitrate) || 0) + (ext === "m4a" ? 10000 : ext === "mp4" ? 5000 : 1000);
    if (!bestAudio || score > bestAudio.score) bestAudio = { score, url: s.url };
  }
  if (bestAudio) return bestAudio.url;

  // 2. Otherwise use a combined stream (e.g. itag 18) — an <audio> element
  //    plays just the audio track of an MP4. Skip Odysee LBRY mirrors (they
  //    return 401 for browser/<audio> clients) and pure-HLS manifests.
  let bestCombined: { score: number; url: string } | null = null;
  for (const s of data.videoStreams ?? []) {
    if (!isPlayableUrl(s.url)) continue;
    if (s.videoOnly) continue; // no audio track
    if (s.url.includes("player.odycdn.com")) continue; // 401-dead LBRY mirror
    const mime = (s.mimeType ?? "").toLowerCase();
    if (mime && !["video/mp4", "audio/mp4"].includes(mime)) continue;
    const score = (Number(s.bitrate) || 0) + (s.url.includes("/videoplayback") ? 1000 : 0);
    if (!bestCombined || score > bestCombined.score) bestCombined = { score, url: s.url };
  }
  return bestCombined?.url ?? null;
}

async function fetchPipedAudio(videoId: string): Promise<string | null> {
  let data: PipedStreamsData | null = null;
  try {
    data = await fetchPipedStreams(videoId);
  } catch {
    return null;
  }
  if (!data) return null;
  return pickPipedAudioStream(data);
}

// ---------------------------------------------------------------------------
// Server fallback
// ---------------------------------------------------------------------------

async function fetchDirectAudio(videoId: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(`/play/${encodeURIComponent(videoId)}`), {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as DirectAudioResponse;
    const url = json?.success ? json.data?.audioUrl : undefined;
    if (!url) return null;
    cacheDirectAudioUrl(videoId, url);
    return url;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function clearDirectAudioCache() {
  cache.clear();
  negativeCache.clear();
}