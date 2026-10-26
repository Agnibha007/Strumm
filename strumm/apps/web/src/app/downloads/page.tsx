"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, HardDrive, Play, Radio, Trash2, WifiOff } from "lucide-react";
import { Song } from "@strumm/types";
import { usePlayerStore } from "web/store/usePlayerStore";
import SafePodcastImage from "web/components/SafePodcastImage";
import {
  formatDownloadSize,
  listPodcastDownloads,
  removePodcastDownload,
  type PodcastDownloadRecord,
} from "web/lib/podcast-downloads";

type StorageEstimate = {
  usage?: number;
  quota?: number;
};

export default function DownloadsPage() {
  const { playSong, setPodcastMode } = usePlayerStore();
  const [downloads, setDownloads] = useState<PodcastDownloadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
  const [online, setOnline] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refreshDownloads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const records = await listPodcastDownloads();
      setDownloads(records);
      if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate().catch(() => null);
        if (estimate) setStorageEstimate(estimate);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to read this device's offline library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDownloads();
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [refreshDownloads]);

  const handlePlay = (record: PodcastDownloadRecord) => {
    const song: Song = {
      videoId: record.id,
      title: record.title,
      artist: record.showTitle || "Podcast",
      thumbnail: record.thumbnail,
      duration: record.duration,
      metadata: {
        album: record.showTitle || "Podcasts",
        audioUrl: record.audioUrl,
        mediaType: "audio",
      },
    };
    setPodcastMode("audio");
    playSong(song, [song]);
  };

  const handleRemove = async (record: PodcastDownloadRecord) => {
    setRemovingId(record.id);
    setError(null);
    try {
      await removePodcastDownload(record.id);
      setDownloads((current) => current.filter((item) => item.id !== record.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this episode.");
    } finally {
      setRemovingId(null);
    }
  };

  const totalSize = downloads.reduce((total, record) => total + record.size, 0);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-0 md:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-3">
          <Link href="/podcasts" className="inline-flex items-center gap-2 text-xs font-semibold text-muted transition hover:text-text">
            <ArrowLeft className="h-4 w-4" />
            Podcasts
          </Link>
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">Your device library</p>
            <h1 className="font-editorial text-4xl font-bold tracking-tight text-text md:text-5xl">Downloads</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
              Podcast episodes saved to this browser. Downloads are available offline on this device and are not synced to your other devices.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-surface/60 px-3.5 py-2.5 text-xs font-semibold text-muted">
          {online ? <HardDrive className="h-4 w-4 text-primary" /> : <WifiOff className="h-4 w-4 text-primary" />}
          {online ? "Offline-ready library" : "You're offline"}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-surface/40 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Episodes saved</p>
          <p className="mt-2 text-2xl font-bold text-text">{downloads.length}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-surface/40 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Download size</p>
          <p className="mt-2 text-2xl font-bold text-text">{formatDownloadSize(totalSize)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-surface/40 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Browser storage used</p>
          <p className="mt-2 text-2xl font-bold text-text">
            {storageEstimate?.usage !== undefined ? formatDownloadSize(storageEstimate.usage) : "—"}
          </p>
          {storageEstimate?.quota !== undefined && (
            <p className="mt-1 text-[10px] text-muted">Estimated limit: {formatDownloadSize(storageEstimate.quota)}</p>
          )}
        </div>
      </div>

      {!online && (
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm text-text">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="leading-relaxed">You&apos;re offline. Saved episodes can play now; episodes that haven&apos;t been downloaded need an internet connection.</p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-relaxed text-primary" role="alert">{error}</div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-border/50 bg-surface/30 py-20 text-center text-sm text-muted">Loading offline library…</div>
      ) : downloads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-surface/20 px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-border/60 bg-surface">
            <Download className="h-6 w-6 text-primary" />
          </div>
          <h2 className="font-editorial text-2xl font-bold text-text">Nothing saved yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
            Open a podcast series and download an episode to keep it ready for flights, commutes, or spotty connections.
          </p>
          <Link href="/podcasts" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-primary-hover">
            <Radio className="h-4 w-4" />
            Browse podcasts
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {downloads.map((record) => (
            <article key={record.id} className="flex flex-col gap-4 rounded-xl border border-border/50 bg-surface/35 p-4 transition hover:border-border/90 sm:flex-row sm:items-center">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/50 bg-surface">
                {record.thumbnail ? (
                  <SafePodcastImage src={record.thumbnail} alt={record.showTitle} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center"><Radio className="h-6 w-6 text-muted" /></div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-editorial text-lg font-bold text-text">{record.title}</h2>
                <p className="mt-0.5 truncate text-xs text-muted">{record.showTitle || "Podcast"}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <span>{formatDownloadSize(record.size)}</span>
                  {record.duration > 0 && <span>{Math.floor(record.duration / 60)} min</span>}
                  <span>Saved {new Date(record.savedAt).toLocaleDateString()}</span>
                  <span className="inline-flex items-center gap-1 text-primary"><HardDrive className="h-3 w-3" />On this device</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => handlePlay(record)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-primary-hover">
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Play
                </button>
                <button type="button" onClick={() => void handleRemove(record)} disabled={removingId === record.id} className="inline-flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2.5 text-xs font-semibold text-muted transition hover:bg-surface-elevated hover:text-text disabled:opacity-50" aria-label={"Remove " + record.title}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {removingId === record.id ? "Removing…" : "Remove"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
