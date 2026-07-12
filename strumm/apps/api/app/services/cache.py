"""
In-memory TTL cache with LRU eviction.

All data lives in RAM only — no disk writes.
Designed for Hugging Face Spaces free tier (no Redis, no files).

TTL values:
  search         5 min     (user queries change frequently)
  artist        30 min     (artist metadata is stable)
  album         30 min     (album metadata is stable)
  lyrics        24 hours   (lyrics rarely change)
  recommendation 15 min    (mood-based, short-lived)
  podcast        1 hour    (episode metadata)
  stream         2 hours   (song metadata)
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Per-namespace TTLs (seconds)
# ---------------------------------------------------------------------------

TTL = {
    "search": 300,           # 5 minutes
    "artist": 1800,          # 30 minutes
    "album": 1800,           # 30 minutes
    "lyrics": 86400,         # 24 hours
    "recommendations": 900,  # 15 minutes
    "podcasts": 3600,        # 1 hour
    "stream": 7200,          # 2 hours
    "user": 15,              # 15 seconds (short TTL to handle request bursts)
    "default": 300,          # 5 minutes
}

MAX_CACHE_SIZE = 200


# ---------------------------------------------------------------------------
# Latency histogram for P50 / P95 / P99 tracking
# ---------------------------------------------------------------------------

_LATENCY_BUCKETS_MS = [50, 100, 200, 500, 1000, 2000, 3000, 5000, 10000]


class LatencyHistogram:
    """Simple fixed-bucket latency histogram (thread-safe via GIL)."""

    def __init__(self, buckets: list[int]) -> None:
        self._buckets = sorted(buckets)
        self._counts: dict[str, int] = {str(b): 0 for b in buckets}
        self._counts["inf"] = 0
        self._total = 0

    def record(self, elapsed_ms: float) -> None:
        self._total += 1
        for b in self._buckets:
            if elapsed_ms <= b:
                self._counts[str(b)] += 1
                return
        self._counts["inf"] += 1

    def percentile(self, pct: float) -> float:
        """Return the latency value at the given percentile (0-100)."""
        if self._total == 0:
            return 0.0
        target = self._total * pct / 100.0
        cumulative = 0
        for b in self._buckets:
            cumulative += self._counts[str(b)]
            if cumulative >= target:
                return float(b)
        return float(self._buckets[-1] * 2) if self._buckets else 0.0

    def snapshot(self) -> dict[str, Any]:
        return {
            "p50_ms": round(self.percentile(50), 1),
            "p95_ms": round(self.percentile(95), 1),
            "p99_ms": round(self.percentile(99), 1),
            "total": self._total,
        }


# Global latency histogram for all YTMusic-bound calls
search_latency_histogram = LatencyHistogram(_LATENCY_BUCKETS_MS)


# ---------------------------------------------------------------------------
# TTL Cache
# ---------------------------------------------------------------------------

class TTLCache:
    """Thread-safe TTL cache with LRU eviction."""

    def __init__(self, max_size: int = MAX_CACHE_SIZE):
        self._max_size = max_size
        self._cache: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def _evict_if_needed(self) -> None:
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def _expire_stale(self) -> None:
        now = time.monotonic()
        stale = [k for k, (expires_at, _) in self._cache.items() if expires_at < now]
        for k in stale:
            self._cache.pop(k, None)

    def get(self, key: str) -> Optional[Any]:
        self._expire_stale()
        entry = self._cache.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at < time.monotonic():
            self._cache.pop(key, None)
            return None
        self._cache.move_to_end(key)
        return value

    def set(self, key: str, value: Any, ttl: int = 300) -> None:
        expires_at = time.monotonic() + ttl
        self._cache[key] = (expires_at, value)
        self._cache.move_to_end(key)
        self._evict_if_needed()

    def delete(self, key: str) -> None:
        self._cache.pop(key, None)

    def clear(self) -> None:
        self._cache.clear()

    @property
    def size(self) -> int:
        self._expire_stale()
        return len(self._cache)


# ---------------------------------------------------------------------------
# Cache instances
# ---------------------------------------------------------------------------

_search_cache = TTLCache(max_size=100)
_artist_cache = TTLCache(max_size=80)
_album_cache = TTLCache(max_size=80)
_lyrics_cache = TTLCache(max_size=100)
_recommendation_cache = TTLCache(max_size=50)
_podcast_cache = TTLCache(max_size=50)
_stream_cache = TTLCache(max_size=100)


# ---------------------------------------------------------------------------
# Public helpers — intended to be called by route handlers
# ---------------------------------------------------------------------------

def cache_key(*parts: str) -> str:
    return ":".join(str(p) for p in parts)


# --- Search (TTL: 5 min) ---

def cache_search(key: str, value: Any) -> None:
    _search_cache.set(key, value, TTL["search"])


def get_cached_search(key: str) -> Optional[Any]:
    return _search_cache.get(key)


# --- Artist (TTL: 30 min) ---

def cache_artist(key: str, value: Any) -> None:
    _artist_cache.set(key, value, TTL["artist"])


def get_cached_artist(key: str) -> Optional[Any]:
    return _artist_cache.get(key)


# --- Album (TTL: 30 min) ---

def cache_album(key: str, value: Any) -> None:
    _album_cache.set(key, value, TTL["album"])


def get_cached_album(key: str) -> Optional[Any]:
    return _album_cache.get(key)


# --- Lyrics (TTL: 24 h) ---

def cache_lyrics(key: str, value: Any) -> None:
    _lyrics_cache.set(key, value, TTL["lyrics"])


def get_cached_lyrics(key: str) -> Optional[Any]:
    return _lyrics_cache.get(key)


# --- Recommendations (TTL: 15 min) ---

def cache_recommendation(key: str, value: Any) -> None:
    _recommendation_cache.set(key, value, TTL["recommendations"])


def get_cached_recommendation(key: str) -> Optional[Any]:
    return _recommendation_cache.get(key)


# --- Podcast (TTL: 1 h) ---

def cache_podcast(key: str, value: Any) -> None:
    _podcast_cache.set(key, value, TTL["podcasts"])


def get_cached_podcast(key: str) -> Optional[Any]:
    return _podcast_cache.get(key)


_user_cache = TTLCache(max_size=100)


# --- Stream metadata (TTL: 2 h) ---

def cache_stream(key: str, value: Any) -> None:
    _stream_cache.set(key, value, TTL["stream"])


def get_cached_stream(key: str) -> Optional[Any]:
    return _stream_cache.get(key)


# --- User cache (TTL: 15s) ---

def cache_user(key: str, value: Any) -> None:
    _user_cache.set(key, value, TTL["user"])


def get_cached_user(key: str) -> Optional[Any]:
    return _user_cache.get(key)


def delete_cached_user(key: str) -> None:
    _user_cache.delete(key)


# --- Latency recording ---

def record_search_latency(elapsed_ms: float) -> None:
    """Record a YTMusic-bound call latency into the global histogram."""
    search_latency_histogram.record(elapsed_ms)


def get_latency_snapshot() -> dict[str, Any]:
    """Return P50 / P95 / P99 latency snapshot."""
    return search_latency_histogram.snapshot()


# --- Clear all ---

def clear_all_caches() -> None:
    _search_cache.clear()
    _artist_cache.clear()
    _album_cache.clear()
    _lyrics_cache.clear()
    _recommendation_cache.clear()
    _podcast_cache.clear()
    _stream_cache.clear()
    _user_cache.clear()
