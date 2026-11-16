"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";
import {
  getSongDownload,
  removeSongDownload,
  saveSongDownload,
  type SongDownloadRecord,
} from "web/lib/podcast-downloads";
import type { Song } from "@strumm/types";

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

interface SongDownloadActionProps {
  song: Pick<Song, "videoId" | "title" | "artist" | "thumbnail" | "duration">;
  compact?: boolean;
  onChange?: () => void;
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    return parsed.detail || parsed.error || "Unable to download this song.";
  } catch {
    return body || "Unable to download this song.";
  }
}

export default function SongDownloadAction({
  song,
  compact = false,
  onChange,
}: SongDownloadActionProps) {
  const [saved, setSaved] = useState<SongDownloadRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    if (!song?.videoId) return;
    getSongDownload(song.videoId)
      .then((record) => {
        if (active) setSaved(record);
      })
      .catch(() => {
        if (active) setError("Offline storage is unavailable in this browser.");
      });
    return () => {
      active = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [song?.videoId]);

  const startDownload = async () => {
    if (downloading || !song?.videoId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setProgress(null);
    setError(null);

    try {
      const storage =
        typeof navigator !== "undefined" && navigator.storage?.estimate
          ? await navigator.storage.estimate().catch(() => null)
          : null;

      const response = await authFetch(apiUrl("/downloads/song"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          videoId: song.videoId,
          title: song.title || "Unknown Title",
          artist: song.artist || "Unknown Artist",
          duration: song.duration || 0,
          rightsConfirmed: true,
        }),
      });

      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const mimeType = (response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (mimeType && !mimeType.startsWith("audio/")) {
        throw new Error("The download service did not return a supported audio file.");
      }

      const rawLength = response.headers.get("content-length");
      const expectedLength = rawLength ? Number(rawLength) : null;
      if (expectedLength !== null && Number.isFinite(expectedLength) && expectedLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("This song is larger than the 500 MiB download limit.");
      }
      if (
        expectedLength !== null &&
        Number.isFinite(expectedLength) &&
        storage?.quota !== undefined &&
        storage.usage !== undefined &&
        expectedLength > Math.max(0, storage.quota - storage.usage)
      ) {
        throw new Error("There is not enough browser storage for this song. Remove an old download and try again.");
      }

      let blob: Blob;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            if (!result.value) continue;
            received += result.value.byteLength;
            if (received > MAX_DOWNLOAD_BYTES) {
              await reader.cancel();
              throw new Error("This song is larger than the 500 MiB download limit.");
            }
            chunks.push(result.value);
            if (expectedLength && expectedLength > 0) {
              setProgress(Math.min(100, Math.round((received / expectedLength) * 100)));
            }
          }
        } finally {
          reader.releaseLock();
        }
        blob = new Blob(chunks, { type: mimeType || "audio/mpeg" });
      } else {
        blob = await response.blob();
      }

      if (!blob.size) throw new Error("The source returned an empty audio file.");
      if (blob.size > MAX_DOWNLOAD_BYTES) {
        throw new Error("This song is larger than the 500 MiB download limit.");
      }

      const record = await saveSongDownload({
        videoId: song.videoId,
        title: song.title || "Unknown Title",
        artist: song.artist || "Unknown Artist",
        thumbnail: song.thumbnail || "",
        duration: song.duration || 0,
        audioUrl: response.headers.get("x-download-source-url") || `https://www.youtube.com/watch?v=${song.videoId}`,
        mimeType: mimeType || blob.type || "audio/mpeg",
        blob,
        sourceProvider: (response.headers.get("x-download-provider") as "yt-dlp" | "direct" | "browser-wasm") || "yt-dlp",
        sourceUrl: response.headers.get("x-download-source-url") || `https://www.youtube.com/watch?v=${song.videoId}`,
      });
      setSaved(record);
      setProgress(100);
      window.dispatchEvent(new Event("strumm:downloads-changed"));
      onChange?.();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "The download failed. Please try again.");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setDownloading(false);
    }
  };

  const cancelDownload = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDownloading(false);
    setProgress(null);
  };

  const removeDownload = async () => {
    if (!song?.videoId) return;
    setError(null);
    try {
      await removeSongDownload(song.videoId);
      setSaved(null);
      setProgress(null);
      window.dispatchEvent(new Event("strumm:downloads-changed"));
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this download.");
    }
  };

  const buttonClass = compact
    ? "inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-2 text-[11px] font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50"
    : "inline-flex items-center gap-2 rounded-lg border border-border/70 px-3.5 py-2.5 text-xs font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50";

  if (!song?.videoId) return null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {downloading ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress === null ? "Downloading…" : "Downloading " + progress + "%"}
          </span>
          <button type="button" onClick={cancelDownload} className={buttonClass} aria-label="Cancel download">
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
      ) : saved ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary" aria-live="polite">
            <Check className="h-3.5 w-3.5" />
            Saved offline
          </span>
          <button type="button" onClick={removeDownload} className={buttonClass} aria-label="Remove downloaded song">
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </button>
        </div>
      ) : (
        <button type="button" onClick={startDownload} className={buttonClass} title="Download for offline (confirm you have rights to save this track)">
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
      )}
      {downloading && progress !== null && (
        <div className="h-1 w-28 overflow-hidden rounded-full bg-border/50" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: progress + "%" }} />
        </div>
      )}
      {error && <p className="max-w-64 text-[11px] leading-relaxed text-primary" role="alert">{error}</p>}
      {!saved && !downloading && (
        <p className="max-w-64 text-[10px] leading-relaxed text-muted/70">
          Saves to this device. Only download tracks you own or have permission to save.
        </p>
      )}
    </div>
  );
}
