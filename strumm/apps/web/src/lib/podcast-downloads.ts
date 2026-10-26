export type PodcastDownloadRecord = {
  id: string;
  episodeId: string;
  title: string;
  showTitle: string;
  thumbnail: string;
  duration: number;
  audioUrl: string;
  mimeType: string;
  collectionType: "podcast" | "playlist";
  collectionId: string;
  collectionName: string;
  sourcePlaylistId?: string;
  sourcePlaylistName?: string;
  size: number;
  savedAt: number;
  blob: Blob;
};

type PodcastDownloadInput = Omit<PodcastDownloadRecord, "id" | "size" | "savedAt" | "blob"> & {
  blob: Blob;
  savedAt?: number;
};

const DATABASE_NAME = "strumm-podcast-downloads";
const DATABASE_VERSION = 1;
const STORE_NAME = "episodes";

let databasePromise: Promise<IDBDatabase> | null = null;

function recordId(episodeId: string): string {
  return episodeId.startsWith("podcast-") ? episodeId : "podcast-" + episodeId;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Offline downloads are not supported in this browser."));
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("savedAt", "savedAt", { unique: false });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };

      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error("Unable to open offline downloads."));
      };

      request.onblocked = () => {
        databasePromise = null;
        reject(new Error("Offline downloads are busy in another tab. Close the other Strumm tab and try again."));
      };
    });
  }

  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Offline download storage failed."));
  });
}

export async function getPodcastDownload(episodeId: string): Promise<PodcastDownloadRecord | null> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const record = await requestResult<PodcastDownloadRecord | undefined>(
    transaction.objectStore(STORE_NAME).get(recordId(episodeId)),
  );
  return record || null;
}

export async function listPodcastDownloads(): Promise<PodcastDownloadRecord[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const records = await requestResult<PodcastDownloadRecord[]>(
    transaction.objectStore(STORE_NAME).getAll(),
  );
  return records
    .map((record) => ({
      ...record,
      collectionType: record.collectionType || "podcast",
      collectionId: record.collectionId || record.episodeId,
      collectionName: record.collectionName || record.showTitle || "Podcasts",
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function savePodcastDownload(input: PodcastDownloadInput): Promise<PodcastDownloadRecord> {
  const database = await openDatabase();
  const record: PodcastDownloadRecord = {
    ...input,
    collectionType: input.collectionType || "podcast",
    collectionId: input.collectionId || input.episodeId,
    collectionName: input.collectionName || input.showTitle || "Podcasts",
    id: recordId(input.episodeId),
    size: input.blob.size,
    savedAt: input.savedAt || Date.now(),
  };
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const request = transaction.objectStore(STORE_NAME).put(record);
  const saved = requestResult(request);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Unable to save this download."));
    transaction.onabort = () => reject(transaction.error || new Error("The download could not be saved."));
  });
  await saved;
  return record;
}

export async function removePodcastDownload(episodeId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(recordId(episodeId));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Unable to remove this download."));
    transaction.onabort = () => reject(transaction.error || new Error("Unable to remove this download."));
  });
}

export function formatDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return value.toFixed(index === 0 ? 0 : 1) + " " + units[index];
}
