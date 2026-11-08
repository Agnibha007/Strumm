import type { Song } from "@strumm/types";
import { Ytdown } from "@4thel00z/ytdown";

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

type BrowserAudioFormat = {
  url: string;
  mime_type?: string | null;
  filesize?: number | null;
  bitrate?: number | null;
  audio?: { bitrate?: number | null; codec?: string } | null;
  video?: unknown;
  http_headers?: [string, string][];
};

type BrowserVideoInfo = {
  formats?: BrowserAudioFormat[];
};

type DownloadProgress = (percent: number | null) => void;

let resolverPromise: Promise<Ytdown> | null = null;

function getProxyUrl(): string {
  const value = process.env.NEXT_PUBLIC_YTDOWN_PROXY_URL?.trim();
  if (!value) throw new Error("Browser download is not configured yet.");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("The browser download proxy must use HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function getResolver(proxyUrl: string): Promise<Ytdown> {
  if (!resolverPromise) {
    resolverPromise = Ytdown.create({ proxy: proxyUrl }).catch((error) => {
      resolverPromise = null;
      throw error;
    });
  }
  return resolverPromise;
}

function isGoogleVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"));
  } catch {
    return false;
  }
}

export function selectBrowserAudioFormat(formats: BrowserAudioFormat[]): BrowserAudioFormat {
  const audioOnly = formats.filter((format) => {
    const mime = (format.mime_type || "").split(";")[0].trim().toLowerCase();
    return Boolean(format.audio) && !format.video && ["audio/mp4", "audio/webm", "audio/ogg"].includes(mime);
  });
  const candidates = audioOnly.length ? audioOnly : formats.filter((format) => {
    const mime = (format.mime_type || "").split(";")[0].trim().toLowerCase();
    return Boolean(format.audio) && ["audio/mp4", "audio/webm", "audio/ogg", "video/mp4"].includes(mime);
  });
  const selected = candidates
    .filter((format) => isGoogleVideoUrl(format.url))
    .sort((a, b) => {
      const mimeA = (a.mime_type || "").toLowerCase();
      const mimeB = (b.mime_type || "").toLowerCase();
      const preferenceA = mimeA.startsWith("audio/mp4") ? 1_000_000 : mimeA.startsWith("audio/webm") ? 500_000 : 0;
      const preferenceB = mimeB.startsWith("audio/mp4") ? 1_000_000 : mimeB.startsWith("audio/webm") ? 500_000 : 0;
      return preferenceB + (b.audio?.bitrate || b.bitrate || 0) - preferenceA - (a.audio?.bitrate || a.bitrate || 0);
    })[0];
  if (!selected) throw new Error("No browser-compatible audio stream was found for this track.");
  return selected;
}

function proxyRequestUrl(proxyUrl: string, targetUrl: string): string {
  return `${proxyUrl}?url=${encodeURIComponent(targetUrl)}`;
}

function formatHeaders(format: BrowserAudioFormat): Headers {
  const headers = new Headers();
  for (const [name, value] of format.http_headers || []) {
    const key = name.toLowerCase();
    if (key === "referer") headers.set("x-ytdown-referer", value);
    if (key === "origin") headers.set("x-ytdown-origin", value);
    if (key === "range") headers.set("range", value);
  }
  return headers;
}

export async function downloadSongInBrowser(
  song: Pick<Song, "videoId" | "title">,
  signal: AbortSignal,
  onProgress: DownloadProgress,
): Promise<{ blob: Blob; mimeType: string; audioUrl: string; sourceProvider: "browser-wasm" }> {
  if (!YOUTUBE_ID_PATTERN.test(song.videoId)) throw new Error("This track does not have a valid YouTube video ID.");
  const proxyUrl = getProxyUrl();
  const resolver = await getResolver(proxyUrl);
  const info = await resolver.resolve(`https://www.youtube.com/watch?v=${song.videoId}`) as BrowserVideoInfo;
  const format = selectBrowserAudioFormat(info.formats || []);
  const rawMimeType = (format.mime_type || "audio/webm").split(";")[0].trim().toLowerCase();
  if (format.filesize && format.filesize > MAX_DOWNLOAD_BYTES) {
    throw new Error("This track is larger than the 500 MiB download limit.");
  }
  const storage = typeof navigator !== "undefined" && navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => null)
    : null;
  if (
    format.filesize &&
    storage?.quota !== undefined &&
    storage.usage !== undefined &&
    format.filesize > Math.max(0, storage.quota - storage.usage)
  ) {
    throw new Error("There is not enough browser storage. Remove an old download and try again.");
  }
  const audioResponse = await fetch(proxyRequestUrl(proxyUrl, format.url), {
    method: "GET",
    headers: formatHeaders(format),
    signal,
  });
  if (!audioResponse.ok || !audioResponse.body) {
    throw new Error(`The source could not provide this audio stream (HTTP ${audioResponse.status}).`);
  }
  const responseMime = (audioResponse.headers.get("content-type") || rawMimeType).split(";")[0].trim().toLowerCase();
  if (!responseMime.startsWith("audio/") && responseMime !== "video/mp4") {
    throw new Error("The source returned an unsupported audio format.");
  }
  const rawLength = audioResponse.headers.get("content-length");
  const expectedLength = rawLength ? Number(rawLength) : format.filesize || null;
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
  const mimeType = responseMime.startsWith("video/mp4") ? "audio/mp4" : responseMime;
  return {
    blob: new Blob(chunks, { type: mimeType }),
    mimeType,
    audioUrl: format.url,
    sourceProvider: "browser-wasm",
  };
}
