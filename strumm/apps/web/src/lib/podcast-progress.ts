import { apiFetch } from "web/lib/api-client";
import type { Song } from "@strumm/types";

const PODCAST_PREFIX = "podcast-";
const STORAGE_KEY = "strumm-podcast-progress-v1";

interface PodcastProgress {
  positionSeconds: number;
  durationSeconds: number;
  updatedAt?: string;
}

interface StoredPodcastProgress {
  episodeId: string;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
  syncedAt: number;
  completed: boolean;
}

type ProgressMap = Record<string, StoredPodcastProgress>;

const memoryProgress = new Map<string, StoredPodcastProgress>();
const inFlightSyncs = new Map<string, Promise<void>>();

export function getPodcastEpisodeId(song?: Pick<Song, "videoId"> | null): string | null {
  if (!song?.videoId || !song.videoId.startsWith(PODCAST_PREFIX)) return null;
  return song.videoId.slice(PODCAST_PREFIX.length);
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function readProgressMap(): ProgressMap {
  const memoryRecords = (): ProgressMap => {
    const records: ProgressMap = {};
    for (const [episodeId, record] of memoryProgress) records[episodeId] = record;
    return records;
  };

  if (typeof localStorage === "undefined") return memoryRecords();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return memoryRecords();
    const records: ProgressMap = {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return memoryRecords();
    for (const [episodeId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<StoredPodcastProgress>;
      if (
        typeof record.positionSeconds !== "number" ||
        !Number.isFinite(record.positionSeconds) ||
        typeof record.durationSeconds !== "number" ||
        !Number.isFinite(record.durationSeconds) ||
        typeof record.updatedAt !== "number" ||
        typeof record.syncedAt !== "number"
      ) continue;
      records[episodeId] = {
        episodeId,
        positionSeconds: Math.max(0, record.positionSeconds),
        durationSeconds: Math.max(0, record.durationSeconds),
        updatedAt: record.updatedAt,
        syncedAt: record.syncedAt,
        completed: record.completed === true,
      };
    }
    for (const [episodeId, record] of memoryProgress) {
      if (!records[episodeId] || records[episodeId].updatedAt <= record.updatedAt) {
        records[episodeId] = record;
      }
    }
    for (const [episodeId, record] of Object.entries(records)) {
      memoryProgress.set(episodeId, record);
    }
    return records;
  } catch {
    return memoryRecords();
  }
}

function writeProgressMap(records: ProgressMap): void {
  for (const [episodeId, record] of Object.entries(records)) {
    memoryProgress.set(episodeId, record);
  }
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Playback progress remains in memory if browser storage is unavailable.
  }
}

function getStoredProgress(episodeId: string): StoredPodcastProgress | null {
  return readProgressMap()[episodeId] || null;
}

function putStoredProgress(record: StoredPodcastProgress): void {
  const records = readProgressMap();
  records[record.episodeId] = record;
  writeProgressMap(records);
}

function toProgress(record: StoredPodcastProgress): PodcastProgress {
  return {
    positionSeconds: record.completed ? 0 : record.positionSeconds,
    durationSeconds: record.durationSeconds,
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

function nextTimestamp(previous?: number): number {
  return Math.max(Date.now(), (previous || 0) + 1);
}

async function syncRecord(record: StoredPodcastProgress): Promise<void> {
  if (!isOnline() || record.syncedAt >= record.updatedAt) return;
  const existingSync = inFlightSyncs.get(record.episodeId);
  if (existingSync) {
    await existingSync;
    const latest = getStoredProgress(record.episodeId);
    if (
      latest &&
      latest.updatedAt > record.updatedAt &&
      latest.syncedAt < latest.updatedAt &&
      isOnline()
    ) {
      return syncRecord(latest);
    }
    return;
  }

  const operation = (async () => {
    let current: StoredPodcastProgress | null = record;
    while (current && isOnline() && current.syncedAt < current.updatedAt) {
      try {
        if (current.completed) {
          await apiFetch(`/podcasts/progress/${encodeURIComponent(current.episodeId)}`, {
            method: "DELETE",
          });
        } else {
          await apiFetch(`/podcasts/progress/${encodeURIComponent(current.episodeId)}`, {
            method: "PUT",
            body: JSON.stringify({
              positionSeconds: Math.max(0, Math.round(current.positionSeconds)),
              durationSeconds: Math.max(0, Math.round(current.durationSeconds)),
            }),
          });
        }
      } catch {
        return;
      }

      const latest = getStoredProgress(current.episodeId);
      if (!latest) return;
      if (latest.updatedAt === current.updatedAt) {
        putStoredProgress({ ...latest, syncedAt: latest.updatedAt });
      }
      current = getStoredProgress(current.episodeId);
      if (!current || current.syncedAt >= current.updatedAt) return;
    }
  })();

  const task = operation;
  inFlightSyncs.set(record.episodeId, task);
  try {
    await task;
  } finally {
    if (inFlightSyncs.get(record.episodeId) === task) {
      inFlightSyncs.delete(record.episodeId);
    }
  }
}

export async function syncPendingPodcastProgress(): Promise<void> {
  if (!isOnline()) return;
  const pending = Object.values(readProgressMap())
    .filter((record) => record.syncedAt < record.updatedAt)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const record of pending) {
    await syncRecord(record);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void syncPendingPodcastProgress();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isOnline()) {
      void syncPendingPodcastProgress();
    }
  });
  if (isOnline()) void syncPendingPodcastProgress();
}

export async function fetchPodcastProgress(
  episodeId: string,
  options: { localOnly?: boolean } = {},
): Promise<PodcastProgress> {
  const local = getStoredProgress(episodeId);
  if (local) {
    if (!options.localOnly && isOnline() && local.syncedAt < local.updatedAt) void syncRecord(local);
    return toProgress(local);
  }

  if (options.localOnly || !isOnline()) return { positionSeconds: 0, durationSeconds: 0 };

  try {
    const remote = await apiFetch<PodcastProgress>(`/podcasts/progress/${encodeURIComponent(episodeId)}`);
    const newerLocal = getStoredProgress(episodeId);
    if (newerLocal) {
      if (newerLocal.syncedAt < newerLocal.updatedAt) void syncRecord(newerLocal);
      return toProgress(newerLocal);
    }

    const remoteUpdatedAt = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
    if (remote.positionSeconds > 0 || remoteUpdatedAt > 0) {
      const updatedAt = Number.isFinite(remoteUpdatedAt) && remoteUpdatedAt > 0 ? remoteUpdatedAt : Date.now();
      putStoredProgress({
        episodeId,
        positionSeconds: Math.max(0, remote.positionSeconds || 0),
        durationSeconds: Math.max(0, remote.durationSeconds || 0),
        updatedAt,
        syncedAt: updatedAt,
        completed: false,
      });
    }
    return {
      positionSeconds: Math.max(0, remote.positionSeconds || 0),
      durationSeconds: Math.max(0, remote.durationSeconds || 0),
      updatedAt: remote.updatedAt,
    };
  } catch {
    return { positionSeconds: 0, durationSeconds: 0 };
  }
}

export async function savePodcastProgress(
  episodeId: string,
  positionSeconds: number,
  durationSeconds: number,
): Promise<void> {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return;

  const previous = getStoredProgress(episodeId);
  const updatedAt = nextTimestamp(previous?.updatedAt);
  const record: StoredPodcastProgress = {
    episodeId,
    positionSeconds: Math.max(0, Math.round(positionSeconds)),
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds)
        : 0,
    updatedAt,
    syncedAt: 0,
    completed: false,
  };
  putStoredProgress(record);
  if (isOnline()) await syncRecord(record);
}

export async function clearPodcastProgress(episodeId: string): Promise<void> {
  const previous = getStoredProgress(episodeId);
  const updatedAt = nextTimestamp(previous?.updatedAt);
  const record: StoredPodcastProgress = {
    episodeId,
    positionSeconds: 0,
    durationSeconds: previous?.durationSeconds || 0,
    updatedAt,
    syncedAt: 0,
    completed: true,
  };
  putStoredProgress(record);
  if (isOnline()) await syncRecord(record);
}
