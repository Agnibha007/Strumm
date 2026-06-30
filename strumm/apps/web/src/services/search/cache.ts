/**
 * Lightweight TTL cache.
 *
 * Intended for in‑memory deduplication of identical API queries within the
 * same serverless function instance.  Each entry automatically expires after
 * `TTL_MS` milliseconds.
 *
 * Because Vercel serverless functions may be recycled between requests,
 * this cache does NOT guarantee persistence across invocations — it is a
 * best‑effort performance optimisation that reduces quota usage during
 * periods of high traffic.
 */

const DEFAULT_TTL_MS = 60_000; // 1 minute

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Retrieve a cached value, or `undefined` if missing / expired. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  /** Store a value with the configured TTL. */
  set(key: string, value: T): void {
    this.store.set(key, { data: value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Explicitly invalidate a single key. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.store.size;
  }
}

/** Application‑wide search cache instance. */
export const searchCache = new TtlCache<any>(60_000);
