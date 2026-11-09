"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { downloadSongInBrowser } from "web/lib/browser-song-download";
import type { Song } from "@strumm/types";
import {
  formatDownloadSize,
  getSongDownload,
  removeSongDownload,
  saveSongDownload,
  type SongDownloadRecord,
} from "web/lib/podcast-downloads";

interface SongDownloadActionProps {
  song: Song;
  compact?: boolean;
}

export default function SongDownloadAction({ song, compact = false }: SongDownloadActionProps) {
  const canDownload = !song.videoId.startsWith("podcast-") && /^[A-Za-z0-9_-]{11}$/.test(song.videoId);
  const [saved, setSaved] = useState<SongDownloadRecord | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedForCurrentSong = saved?.videoId === song.videoId ? saved : null;
  const abortRef = useRef<AbortController | null>(null);
  const previousSongIdRef = useRef(song.videoId);

  useEffect(() => {
    let active = true;
    const songChanged = previousSongIdRef.current !== song.videoId;
    previousSongIdRef.current = song.videoId;

    if (songChanged) {
      abortRef.current?.abort();
      abortRef.current = null;
      setSaved(null);
      setDownloading(false);
      setProgress(null);
      setError(null);
    } else {
      getSongDownload(song.videoId)
        .then((record) => {
          if (active) setSaved(record);
        })
        .catch(() => {
          if (active) setError("Offline storage is unavailable in this browser.");
        });
    }

    return () => {
      active = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [song.videoId]);

  const startDownload = async () => {
    if (downloading || !canDownload) return;
    const confirmed = window.confirm("Only download this track if you own it or have permission from the rights holder. Continue?");
    if (!confirmed) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setProgress(null);
    setError(null);

    try {
      const result = await downloadSongInBrowser(song, controller.signal, setProgress);
      const record = await saveSongDownload({
        videoId: song.videoId,
        title: song.title,
        artist: song.artist,
        thumbnail: song.thumbnail,
        duration: song.duration,
        audioUrl: result.audioUrl,
        mimeType: result.mimeType,
        blob: result.blob,
        sourceProvider: result.sourceProvider,
        sourceUrl: `https://www.youtube.com/watch?v=${song.videoId}`,
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
    ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-2 py-2 text-[11px] font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50"
    : "inline-flex items-center gap-2 rounded-lg border border-border/70 px-3.5 py-2.5 text-xs font-semibold text-muted hover:text-text hover:bg-surface-elevated transition disabled:opacity-50";

  if (!canDownload) return null;

  return (
    <div className="flex w-fit max-w-full shrink-0 min-w-0 flex-col items-center gap-1.5 sm:items-start">
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
      ) : savedForCurrentSong ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary" aria-live="polite">
            <Check className="h-3.5 w-3.5" />
            {compact ? <span className="hidden xl:inline">Saved</span> : "Saved offline"}
            <span className="sr-only">{compact ? "Saved offline. " : ""}{formatDownloadSize(savedForCurrentSong.size)}</span>
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
      {error && <p className="max-w-48 break-words text-center text-[11px] leading-relaxed text-primary sm:text-left" role="alert">{error}</p>}
    </div>
  );
}
