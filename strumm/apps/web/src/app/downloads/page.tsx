"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  HardDrive,
  ListMusic,
  Play,
  Radio,
  Search,
  Trash2,
  WifiOff,
} from "lucide-react";
import { Song } from "@strumm/types";
import SafePodcastImage from "web/components/SafePodcastImage";
import { usePlayerStore } from "web/store/usePlayerStore";
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

type DownloadGroup = {
  key: string;
  name: string;
  type: "podcast" | "playlist";
  thumbnail: string;
  records: PodcastDownloadRecord[];
};

function collectionFor(record: PodcastDownloadRecord) {
  const type = record.collectionType || "podcast";
  const name = record.collectionName || record.showTitle || "Podcasts";
  const id = record.collectionId || record.episodeId;
  return { type, name, id, key: type + ":" + id + ":" + name };
}

export default function DownloadsPage() {
  const { playSong, setPodcastMode } = usePlayerStore();
  const [downloads, setDownloads] = useState<PodcastDownloadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
  const [online, setOnline] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

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

  const filteredDownloads = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return downloads;
    return downloads.filter((record) =>
      [
        record.title,
        record.showTitle,
        record.collectionName,
        record.sourcePlaylistName,
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [downloads, search]);

  const groups = useMemo<DownloadGroup[]>(() => {
    const grouped = new Map<string, DownloadGroup>();
    for (const record of filteredDownloads) {
      const collection = collectionFor(record);
      const existing = grouped.get(collection.key);
      if (existing) {
        existing.records.push(record);
      } else {
        grouped.set(collection.key, {
          key: collection.key,
          name: collection.name,
          type: collection.type,
          thumbnail: record.thumbnail,
          records: [record],
        });
      }
    }

    return [...grouped.values()]
      .map((group) => ({
        ...group,
        records: group.records.sort((a, b) => b.savedAt - a.savedAt),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredDownloads]);

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
  const podcastCount = downloads.filter((record) => (record.collectionType || "podcast") === "podcast").length;
  const playlistCount = downloads.filter((record) => record.collectionType === "playlist").length;

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => ({ ...current, [key]: current[key] === false }));
  };

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
              Everything saved for offline listening, organised by podcast or playlist. Downloads stay on this browser and device.
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
          <p className="mt-1 text-[10px] text-muted">
            {podcastCount} podcast episode{podcastCount === 1 ? "" : "s"}{playlistCount ? " · " + playlistCount + " playlist item" + (playlistCount === 1 ? "" : "s") : ""}
          </p>
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

      {!loading && downloads.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search downloaded episodes, podcasts, or playlists"
            aria-label="Search downloads"
            className="w-full rounded-xl border border-border/60 bg-surface/40 py-3 pl-10 pr-4 text-sm text-text outline-none transition placeholder:text-muted focus:border-primary/60"
          />
        </div>
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
      ) : filteredDownloads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-surface/20 px-6 py-12 text-center">
          <Search className="mx-auto mb-3 h-6 w-6 text-muted" />
          <h2 className="font-editorial text-xl font-bold text-text">No matching downloads</h2>
          <p className="mt-2 text-sm text-muted">Try a different podcast, playlist, or episode title.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const expanded = expandedGroups[group.key] !== false;
            const groupSize = group.records.reduce((total, record) => total + record.size, 0);
            return (
              <section key={group.key} className="overflow-hidden rounded-2xl border border-border/60 bg-surface/30">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-surface/60 sm:p-5"
                >
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-border/50 bg-surface">
                    {group.thumbnail ? (
                      <SafePodcastImage src={group.thumbnail} alt={group.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        {group.type === "playlist" ? <ListMusic className="h-6 w-6 text-muted" /> : <Radio className="h-6 w-6 text-muted" />}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                      {group.type === "playlist" ? "Downloaded from playlist" : "Podcast"}
                    </span>
                    <h2 className="truncate font-editorial text-lg font-bold text-text sm:text-xl">{group.name}</h2>
                    <p className="mt-1 text-xs text-muted">
                      {group.records.length} episode{group.records.length === 1 ? "" : "s"} · {formatDownloadSize(groupSize)}
                    </p>
                  </div>
                </button>

                {expanded && (
                  <div className="space-y-2 border-t border-border/50 p-3 sm:p-4">
                    {group.records.map((record) => (
                      <article key={record.id} className="flex flex-col gap-3 rounded-xl border border-border/40 bg-background/40 p-3 sm:flex-row sm:items-center sm:gap-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-sm font-semibold text-text">{record.title}</h3>
                          <p className="mt-1 truncate text-xs text-muted">{record.showTitle || group.name}</p>
                          {record.sourcePlaylistName && group.type !== "playlist" && (
                            <p className="mt-1 truncate text-[11px] text-muted">Playlist: {record.sourcePlaylistName}</p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                            <span>{formatDownloadSize(record.size)}</span>
                            {record.duration > 0 && <span>{Math.floor(record.duration / 60)} min</span>}
                            <span>Saved {new Date(record.savedAt).toLocaleDateString()}</span>
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
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
