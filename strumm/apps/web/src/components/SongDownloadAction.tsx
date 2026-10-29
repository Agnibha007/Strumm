"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import type { Song } from "@strumm/types";
import {
  formatDownloadSize,
  getAuthorizedSongDownloadUrl,
  getSongDownload,
  removeSongDownload,
  saveSongDownload,
  type SongDownloadRecord,
} from "web/lib/podcast-downloads";

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

interface SongDownloadActionProps {
  song: Song;
  compact?: boolean;
}

export default function SongDownloadAction({ song, compact = false }: SongDownloadActionProps) {
  const downloadUrl = getAuthorizedSongDownloadUrl(song.metadata?.downloadUrl);
  const [saved, setSaved] = useState<SongDownloadRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
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
  }, [song.videoId]);

  const startDownload = async () => {
    if (!downloadUrl || downloading) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setProgress(null);
    setError(null);

    try {
      const storage = typeof navigator !== "undefined" && navigator.storage?.estimate
        ? await navigator.storage.estimate().catch(() => null)
        : null;
      const response = await fetch(downloadUrl, { signal: controller.signal });

      if (!response.ok) {
        throw new Error(response.status === 404
          ? "The source no longer offers this download."
          : "Unable to download this track from its source.");
      }

      const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!mimeType.startsWith("audio/")) {
        throw new Error("The track source did not return an audio file.");
      }

      const rawLength = response.headers.get("content-length");
      const expectedLength = rawLength ? Number(rawLength) : null;
      if (expectedLength !== null && Number.isFinite(expectedLength) && expectedLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("This track is larger than the 500 MiB download limit.");
      }
      if (
        expectedLength !== null &&
        Number.isFinite(expectedLength) &&
        storage?.quota !== undefined &&
        storage.usage !== undefined &&
        expectedLength > Math.max(0, storage.quota - storage.usage)
      ) {
        throw new Error("There is not enough browser storage. Remove an old download and try again.");
      }

      let blob: Blob;
      if (response.body) {
        const reader = response.body.getReader();
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
            if (expectedLength && expectedLength > 0) {
              setProgress(Math.min(100, Math.round((received / expectedLength) * 100)));
            }
          }
        } finally {
          reader.releaseLock();
        }
        blob = new Blob(chunks, { type: mimeType });
      } else {
        blob = await response.blob();
      }

      if (!blob.size) throw new Error("The source returned an empty audio file.");
      if (blob.size > MAX_DOWNLOAD_BYTES) {
        throw new Error("This track is larger than the 500 MiB download limit.");
      }

      const record = await saveSongDownload({
        videoId: song.videoId,
        title: song.title,
        artist: song.artist,
        thumbnail: song.thumbnail,
        duration: song.duration,
        audioUrl: downloadUrl,
        mimeType,
        blob,
      });
      setSaved(record);
      setProgress(100);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("strumm:downloads-changed"));
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
    setError(null);
    try {
      await removeSongDownload(song.videoId);
      setSaved(null);
      setProgress(null);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("strumm:downloads-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this download.");
    }
  };

  const buttonClass = compact
    ? "inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-2 py-2 text-[11px] font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50"
    : "inline-flex items-center gap-2 rounded-lg border border-border/70 px-3.5 py-2.5 text-xs font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50";

  if (song.videoId.startsWith("podcast-")) return null;

  if (!downloadUrl && !saved) {
    return (
      <button
        type="button"
        disabled
        className={buttonClass}
        aria-label="Offline download unavailable for this track"
        title="Offline downloads are available only when the track source explicitly permits them."
      >
        <Download className="h-3.5 w-3.5" />
        {!compact && "Unavailable"}
      </button>
    );
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {downloading ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary" aria-live="polite">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress === null ? "Downloading…" : "Downloading " + progress + "%"}
          </span>
          <button type="button" onClick={cancelDownload} className={buttonClass} aria-label="Cancel song download">
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
      ) : saved ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary" aria-live="polite">
            <Check className="h-3.5 w-3.5" />
            {compact ? "Saved" : "Saved offline"}
            <span className="sr-only">{formatDownloadSize(saved.size)}</span>
          </span>
          <button type="button" onClick={removeDownload} className={buttonClass} aria-label="Remove downloaded song">
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </button>
        </div>
      ) : (
        <button type="button" onClick={startDownload} className={buttonClass}>
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
      )}
      {downloading && progress !== null && (
        <div className="h-1 w-28 overflow-hidden rounded-full bg-border/50" role="progressbar" aria-label="Song download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: progress + "%" }} />
        </div>
      )}
      {error && <p className="max-w-64 text-[11px] leading-relaxed text-primary" role="alert">{error}</p>}
    </div>
  );
}
