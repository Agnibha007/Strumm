import { apiUrl } from "web/lib/api";

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
const REQUEST_TIMEOUT_MS = 15_000;

const cache = new Map<string, { url: string; at: number }>();

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
}

/**
 * Resolve a direct audio URL for background / lock-screen playback.
 *
 * The URL is fetched once from `/play/{id}` and memoized client-side for
 * 45 minutes (server cache TTL is 2h). Returns null when the track has no
 * direct audio (e.g. sign-in required) — callers silently fall back to the
 * YouTube iframe.
 */
export async function resolveDirectAudioUrl(videoId: string): Promise<string | null> {
  if (!videoId) return null;

  const cached = getCachedDirectAudioUrl(videoId);
  if (cached) return cached;

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
}