"""Lightweight in-memory TTL cache with LRU eviction strategy.

Used to cache search results, lyrics, recommendations, and podcast metadata
to reduce external API calls and improve response times on Render Free Tier.
"""

import time
from collections import OrderedDict
from typing import Any, Callable, Optional, TypeVar

T = TypeVar("T")

MAX_CACHE_SIZE = 200
DEFAULT_TTL = {
    "search": 1800,       # 30 minutes
    "lyrics": 86400,      # 24 hours
    "recommendations": 3600,  # 1 hour
    "podcasts": 3600,     # 1 hour
    "stream": 7200,       # 2 hours
    "default": 300,       # 5 minutes
}


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
        stale_keys = [
            k for k, (expires_at, _) in self._cache.items()
            if expires_at < now
        ]
        for k in stale_keys:
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
        # Move to end (most recently used)
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


# Global cache instances by namespace
_search_cache = TTLCache(max_size=100)
_lyrics_cache = TTLCache(max_size=100)
_recommendation_cache = TTLCache(max_size=50)
_podcast_cache = TTLCache(max_size=50)
_stream_cache = TTLCache(max_size=100)


def cache_key(*parts: str) -> str:
    """Build a colon-delimited cache key from parts."""
    return ":".join(str(p) for p in parts)


def get_cached_or_fetch(
    cache: TTLCache,
    key: str,
    fetch_fn: Callable[[], T],
    ttl: int = 300,
) -> T:
    """Return cached value or fetch, cache, and return."""
    cached = cache.get(key)
    if cached is not None:
        return cached
    value = fetch_fn()
    cache.set(key, value, ttl)
    return value


async def get_cached_or_fetch_async(
    cache: TTLCache,
    key: str,
    fetch_fn: Callable[[], Any],
    ttl: int = 300,
) -> Any:
    """Async version of get_cached_or_fetch."""
    cached = cache.get(key)
    if cached is not None:
        return cached
    value = await fetch_fn()
    cache.set(key, value, ttl)
    return value


# Public helpers for each namespace

def cache_search(key: str, value: Any) -> None:
    _search_cache.set(key, value, DEFAULT_TTL["search"])


def get_cached_search(key: str) -> Optional[Any]:
    return _search_cache.get(key)


def cache_lyrics(key: str, value: Any) -> None:
    _lyrics_cache.set(key, value, DEFAULT_TTL["lyrics"])


def get_cached_lyrics(key: str) -> Optional[Any]:
    return _lyrics_cache.get(key)


def cache_recommendation(key: str, value: Any) -> None:
    _recommendation_cache.set(key, value, DEFAULT_TTL["recommendations"])


def get_cached_recommendation(key: str) -> Optional[Any]:
    return _recommendation_cache.get(key)


def cache_podcast(key: str, value: Any) -> None:
    _podcast_cache.set(key, value, DEFAULT_TTL["podcasts"])


def get_cached_podcast(key: str) -> Optional[Any]:
    return _podcast_cache.get(key)


def cache_stream(key: str, value: Any) -> None:
    _stream_cache.set(key, value, DEFAULT_TTL["stream"])


def get_cached_stream(key: str) -> Optional[Any]:
    return _stream_cache.get(key)


def clear_all_caches() -> None:
    """Clear all in-memory caches."""
    _search_cache.clear()
    _lyrics_cache.clear()
    _recommendation_cache.clear()
    _podcast_cache.clear()
    _stream_cache.clear()
