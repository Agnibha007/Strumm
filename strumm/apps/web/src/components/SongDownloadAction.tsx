"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";
import type { Song } from "@strumm/types";
import { usePlayerStore } from "web/store/usePlayerStore";
import {
  formatDownloadSize,
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

function decodeHeaderValue(value: string | null) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function SongDownloadAction({ song, compact = false }: SongDownloadActionProps) {
  const downloadUrl = apiUrl("/downloads/song");
  const currentSongId = usePlayerStore((state) => state.currentSong?.videoId ?? null);
  const canDownload = !song.videoId.startsWith("podcast-");
  const [saved, setSaved] = useState<SongDownloadRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const savedInThisSessionRef = useRef(false);
  const playerSongIdAtSaveRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (!savedInThisSessionRef.current || !currentSongId) return;
    if (currentSongId === playerSongIdAtSaveRef.current) return;

    savedInThisSessionRef.current = false;
    setSaved(null);
    setProgress(null);
  }, [currentSongId]);

  const startDownload = async () => {
    if (downloading || !canDownload) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setProgress(null);
    setError(null);

    try {
      const storage = typeof navigator !== "undefined" && navigator.storage?.estimate
        ? await navigator.storage.estimate().catch(() => null)
        : null;
      const response = await authFetch(downloadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: song.title,
          artist: song.artist,
          duration: song.duration,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = response.status === 404
          ? "No matching track with a verified public download licence was found."
          : response.status === 403
            ? "The matched provider does not allow this track to be downloaded."
            : "Unable to download this track.";
        const parsed = await response.json().catch(() => null);
        if (parsed?.detail) message = parsed.detail;
        else if (parsed?.error) message = parsed.error;
        throw new Error(message);
      }

      const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (mimeType !== "audio/mpeg" && mimeType !== "audio/mp3") {
        throw new Error("The matched provider did not return an MP3 file.");
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

      if (!blob.size) throw new Error("The download source returned an empty audio file.");
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
        sourceProvider: (response.headers.get("X-Download-Provider") || "audius") as SongDownloadRecord["sourceProvider"],
        sourceUrl: decodeHeaderValue(response.headers.get("X-Download-Source-Url")) || undefined,
        license: decodeHeaderValue(response.headers.get("X-Download-License")) || undefined,
        licenseUrl: decodeHeaderValue(response.headers.get("X-Download-License-Url")) || undefined,
        attribution: decodeHeaderValue(response.headers.get("X-Download-Attribution")) || undefined,
        copyrightLine: decodeHeaderValue(response.headers.get("X-Download-Creator")) || undefined,
      });
      playerSongIdAtSaveRef.current = currentSongId;
      savedInThisSessionRef.current = true;
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
      savedInThisSessionRef.current = false;
      playerSongIdAtSaveRef.current = null;
      setProgress(null);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("strumm:downloads-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this download.");
    }
  };

  const buttonClass = compact
    ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-2 py-2 text-[11px] font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50"
    : "inline-flex items-center gap-2 rounded-lg border border-border/70 px-3.5 py-2.5 text-xs font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50";

  if (!canDownload) return null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {downloading ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary" aria-live="polite">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress === null ? "Downloading…" : "Downloading " + progress + "%"}
          </span>
          <button type="button" onClick={cancelDownload} className={buttonClass} aria-label="Cancel song download" title="Cancel download">
            <X className="h-3.5 w-3.5" />
            {compact ? <span className="hidden xl:inline">Cancel</span> : "Cancel"}
          </button>
        </div>
      ) : saved ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary" aria-live="polite">
            <Check className="h-3.5 w-3.5" />
            {compact ? <span className="hidden xl:inline">Saved</span> : "Saved offline"}
            <span className="sr-only">{compact ? "Saved offline. " : ""}{formatDownloadSize(saved.size)}</span>
          </span>
          <button type="button" onClick={removeDownload} className={buttonClass} aria-label="Remove downloaded song" title="Remove download">
            <Trash2 className="h-3.5 w-3.5" />
            {compact ? <span className="hidden xl:inline">Remove</span> : "Remove"}
          </button>
        </div>
      ) : (
        <button type="button" onClick={startDownload} className={buttonClass} aria-label="Download song offline" title="Download song offline">
          <Download className="h-3.5 w-3.5" />
          {compact ? <span className="hidden xl:inline">Download</span> : "Download"}
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
