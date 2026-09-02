/**
 * Shared, deduplicated image loader.
 *
 * Problem we solve: rooms/search/discovery grids render dozens of <img>
 * elements at once, each firing its own YouTube/CDN request. The browser has
 * no global notion of "this whole grid is loading" and will happily open 40+
 * connections, stalling every thumb behind the slowest host. Individual
 * artworks (SongArtwork/SafePodcastImage) also fetch several candidate URLs
 * with per-element retries, repeating the same fetch on every remount.
 *
 * This module owns a single throttled pipeline:
 *   - dedup: one network request per URL, shared by every consumer.
 *   - priority: P0 (hero) drains before P3 (grid filler).
 *   - bounded concurrency (~6) so a grid never saturates the connection pool.
 *   - bounded retries with backoff (no storm on 404/blocked CDNs).
 *   - bounded "known good / known bad" caches so hot paths are instant.
 *
 * Components keep rendering plain <img> elements (so layout/events behave
 * exactly as before) but prime them through here via `preloadImage`, or use
 * `loadImage` where they need the resolved outcome.
 */

export type ImagePriority = 0 | 1 | 2 | 3; // 0 = hero/visible now, 3 = wallpaper

const MAX_CONCURRENCY = 6;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 600;
const CACHE_LIMIT = 600;

type QueueEntry = {
  url: string;
  priority: ImagePriority;
  seq: number;
  resolve: (ok: boolean) => void;
};

type FailedInfo = { attempts: number; failedAt: number };

class ImageLoader {
  private inflight = new Map<string, Promise<boolean>>();
  private queue: QueueEntry[] = [];
  private seq = 0;
  private active = 0;

  private succeeded = new Set<string>();
  private failed = new Map<string, FailedInfo>();

  /**
   * Resolve `true` when the image at `url` finished loading, `false` when it
   * is known-bad or exhausted our bounded retries. Idempotent per URL —
   * concurrent callers share a single fetch.
   */
  load(url: string, priority: ImagePriority = 3): Promise<boolean> {
    if (!url) return Promise.resolve(false);

    if (this.succeeded.has(url)) return Promise.resolve(true);

    const info = this.failed.get(url);
    if (info && info.attempts >= MAX_ATTEMPTS) return Promise.resolve(false);
    if (info && Date.now() < info.failedAt + RETRY_BACKOFF_MS) {
      return Promise.resolve(false);
    }

    const existing = this.inflight.get(url);
    if (existing) return existing;

    const promise = new Promise<boolean>((resolve) => {
      this.queue.push({ url, priority, seq: this.seq++, resolve });
      this.drain();
    });
    this.inflight.set(url, promise);
    return promise;
  }

  /** Fire-and-forget prefetch through the same throttled pipeline. */
  preload(url: string, priority: ImagePriority = 3): void {
    if (!url) return;
    if (this.succeeded.has(url)) return;
    if (this.inflight.has(url)) return;
    void this.load(url, priority);
  }

  /** Number of URLs currently queued or in flight (for tests/tuning). */
  get pendingCount(): number {
    return this.queue.length + this.active;
  }

  private drain(): void {
    if (this.active >= MAX_CONCURRENCY || this.queue.length === 0) return;

    // Sort candidates highest-priority first, FIFO for ties, then start up to
    // the free slots. Re-sorting a small list per drain is cheap and keeps the
    // priority contract simple.
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);

    while (this.active < MAX_CONCURRENCY && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.active += 1;
      this.fetch(entry);
    }
  }

  private fetch(entry: QueueEntry): void {
    const { url, resolve } = entry;
    let attempts = this.failed.get(url)?.attempts ?? 0;

    const run = () => {
      const img = new Image();
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      const onDone = (ok: boolean) => {
        this.active -= 1;
        this.inflight.delete(url);
        if (ok) {
          this.rememberSuccess(url);
          this.failed.delete(url);
        } else {
          attempts += 1;
          this.failed.set(url, { attempts, failedAt: Date.now() });
        }
        resolve(ok);
        this.prune();
        this.drain();
      };
      img.onload = () => onDone(true);
      img.onerror = () => onDone(false);
      img.src = url;
    };

    // First attempt immediately; retries (bounded) get a short backoff so a
    // flaky CDN doesn't turn into a request storm across the whole grid.
    if (attempts === 0) {
      run();
    } else {
      window.setTimeout(run, RETRY_BACKOFF_MS);
    }
  }

  private rememberSuccess(url: string): void {
    this.succeeded.add(url);
    if (this.succeeded.size > CACHE_LIMIT) {
      const [first] = this.succeeded;
      if (first !== undefined) this.succeeded.delete(first);
    }
  }

  private prune(): void {
    if (this.failed.size <= CACHE_LIMIT) return;
    // Drop the oldest failures first.
    const entries = [...this.failed.entries()].sort((a, b) => a[1].failedAt - b[1].failedAt);
    const toDrop = this.failed.size - Math.floor(CACHE_LIMIT / 2);
    for (let i = 0; i < toDrop; i++) {
      this.failed.delete(entries[i][0]);
    }
  }
}

const sharedLoader = new ImageLoader();

export function loadImage(url: string, priority: ImagePriority = 3): Promise<boolean> {
  return sharedLoader.load(url, priority);
}

export function preloadImage(url: string, priority: ImagePriority = 3): void {
  sharedLoader.preload(url, priority);
}