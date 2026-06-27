"""
Provider Registry — central hub for the music provider architecture.

Manages multiple MusicProvider instances with:
  - Automatic provider selection (healthy → degraded → offline)
  - Circuit breaker with configurable cooldown
  - Transparent failover between providers
  - Request coalescing (deduplicate concurrent identical requests)
  - In-memory TTL caching (namespaced, no disk writes)
  - Per-provider health metrics & latency tracking
  - Automatic provider recovery
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Optional

from app.services.cache import (
    cache_search,
    get_cached_search,
    cache_artist,
    get_cached_artist,
    cache_album,
    get_cached_album,
    cache_lyrics,
    get_cached_lyrics,
    cache_stream,
    get_cached_stream,
    record_search_latency,
)
from app.services.coalescer import get_coalescer

from app.services.providers.base import (
    MusicProvider,
    ProviderHealth,
    ProviderMetrics,
    ProviderStatus,
    COOLDOWN_BASE_SECONDS,
    COOLDOWN_FAILURE_THRESHOLD,
    COOLDOWN_MAX_SECONDS,
    DEGRADED_LATENCY_THRESHOLD,
)

logger = logging.getLogger("strumm-provider-registry")

# How often to re-check offline providers (seconds)
RECOVERY_CHECK_INTERVAL = 60.0

# How often to refresh provider health status
HEALTH_CHECK_INTERVAL = 30.0


class ProviderRegistry:
    """
    Registry of music providers with health monitoring and auto-failover.

    Usage:
        registry = ProviderRegistry()
        registry.register(InnerTubeProvider())
        registry.register(YTMusicProvider())

        # Get the best available provider
        provider = await registry.get_provider()

        # Routes just call:
        result = await registry.search("lofi beats", filter="songs")
    """

    def __init__(self) -> None:
        self._providers: list[MusicProvider] = []
        self._health_cache: dict[str, tuple[float, ProviderHealth]] = {}
        self._coalescer = get_coalescer()
        self._lock = asyncio.Lock()
        self._recovery_task: Optional[asyncio.Task] = None

    # -- Registration -----------------------------------------------------

    def register(self, provider: MusicProvider) -> None:
        """Register a provider. First registered = highest priority."""
        self._providers.append(provider)
        logger.info(f"Provider registered: {provider.name}")

    @property
    def providers(self) -> list[MusicProvider]:
        return list(self._providers)

    # -- Provider selection -----------------------------------------------

    async def get_provider(self) -> Optional[MusicProvider]:
        """
        Return the best available provider (healthiest, highest priority).

        Checks cached health status first, then falls through providers
        in registration order.
        """
        now = time.monotonic()

        for provider in self._providers:
            # Check cached health
            cached = self._health_cache.get(provider.name)
            if cached:
                cached_time, cached_health = cached
                # Re-check if stale
                if now - cached_time < HEALTH_CHECK_INTERVAL:
                    if cached_health.is_available:
                        return provider
                    continue

            # Run a fresh health check
            health = await self._check_provider_health(provider)
            if health.is_available:
                return provider

        # All providers offline — return the first one anyway (graceful degradation)
        return self._providers[0] if self._providers else None

    async def _check_provider_health(
        self, provider: MusicProvider
    ) -> ProviderHealth:
        """Check a provider's health and cache the result."""
        try:
            health = await provider.check_health()
        except Exception as exc:
            health = ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=ProviderMetrics(),
                is_available=False,
            )
            logger.warning(f"Health check failed for {provider.name}: {exc!s:.120}")

        self._health_cache[provider.name] = (time.monotonic(), health)
        return health

    # -- Provider-aware methods (with caching + coalescing) ----------------

    async def search(
        self, query: str, filter: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """
        Search across providers with caching and coalescing.

        Cache key includes filter for fine-grained caching.
        """
        cache_key_str = f"provider:search:{filter or 'all'}:{query}"

        # 1. Check cache
        cached = get_cached_search(cache_key_str)
        if cached is not None:
            return cached

        # 2. Execute via coalescer (dedup concurrent identical requests)
        start = time.monotonic()
        try:
            results = await self._coalescer.execute(
                key=f"provider:search:{query}:{filter}",
                factory=lambda: self._execute_search(query, filter),
                timeout=15.0,
            )
            elapsed_ms = (time.monotonic() - start) * 1000
            record_search_latency(elapsed_ms)

            # 3. Cache results
            if results:
                cache_search(cache_key_str, results)

            return results or []
        except Exception as exc:
            logger.error(f"Provider search failed for '{query}': {exc!s:.150}")
            return []

    async def _execute_search(
        self, query: str, filter: Optional[str] = None
    ) -> Optional[list[dict[str, Any]]]:
        """Execute search against the best available provider."""
        provider = await self.get_provider()
        if not provider:
            logger.warning("No provider available for search")
            return None

        logger.info(f"Using provider '{provider.name}' for search '{query}'")
        results = await provider.search(query, filter=filter)

        # If first provider returns empty and we have a fallback, try it
        if not results:
            fallback = await self._get_fallback_provider(provider)
            if fallback:
                logger.info(f"Falling back to provider '{fallback.name}' for search '{query}'")
                results = await fallback.search(query, filter=filter)

        return results

    async def get_song(self, video_id: str) -> Optional[dict[str, Any]]:
        """Get song metadata with caching."""
        cache_key_str = f"provider:song:{video_id}"

        cached = get_cached_stream(cache_key_str)
        if cached:
            return cached

        provider = await self.get_provider()
        if not provider:
            return None

        result = await provider.get_song(video_id)
        fallback = None
        if not result:
            fallback = await self._get_fallback_provider(provider)
            if fallback:
                result = await fallback.get_song(video_id)

        if result:
            cache_stream(cache_key_str, result)
        return result

    async def get_album(self, browse_id: str) -> Optional[dict[str, Any]]:
        """Get album details with caching."""
        cache_key_str = f"provider:album:{browse_id}"

        cached = get_cached_album(cache_key_str)
        if cached:
            return cached

        provider = await self.get_provider()
        if not provider:
            return None

        result = await provider.get_album(browse_id)
        fallback = None
        if not result:
            fallback = await self._get_fallback_provider(provider)
            if fallback:
                result = await fallback.get_album(browse_id)

        if result:
            cache_album(cache_key_str, result)
        return result

    async def get_playlist(
        self, playlist_id: str, limit: Optional[int] = None
    ) -> Optional[dict[str, Any]]:
        """Get playlist tracks with caching."""
        cache_key_str = f"provider:playlist:{playlist_id}:{limit}"

        cached = get_cached_search(cache_key_str)
        if cached:
            return cached

        provider = await self.get_provider()
        if not provider:
            return None

        result = await provider.get_playlist(playlist_id, limit=limit)
        if not result:
            fallback = await self._get_fallback_provider(provider)
            if fallback:
                result = await fallback.get_playlist(playlist_id, limit=limit)

        if result:
            cache_search(cache_key_str, result)
        return result

    async def get_watch_playlist(
        self, video_id: str, limit: int = 1
    ) -> Optional[dict[str, Any]]:
        """Get related tracks (radio) with caching."""
        cache_key_str = f"provider:watch:{video_id}:{limit}"

        cached = get_cached_stream(cache_key_str)
        if cached:
            return cached

        provider = await self.get_provider()
        if not provider:
            return None

        result = await provider.get_watch_playlist(video_id, limit=limit)
        if not result:
            fallback = await self._get_fallback_provider(provider)
            if fallback:
                result = await fallback.get_watch_playlist(video_id, limit=limit)

        if result:
            cache_stream(cache_key_str, result)
        return result

    async def get_lyrics(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get lyrics.

        Note: Only YTMusic provider supports lyrics browsing.
        InnerTube (WEB client) does not. If InnerTube is the active
        provider, this will try YTMusic as fallback automatically.
        """
        provider = await self.get_provider()
        if not provider:
            return None

        result = await provider.get_lyrics(browse_id)
        if not result:
            fallback = await self._get_fallback_provider(provider)
            if fallback:
                result = await fallback.get_lyrics(browse_id)

        return result

    # -- Fallback logic ---------------------------------------------------

    async def _get_fallback_provider(
        self, current: MusicProvider
    ) -> Optional[MusicProvider]:
        """Return the next available provider after *current*."""
        for provider in self._providers:
            if provider.name == current.name:
                continue
            health = await self._check_provider_health(provider)
            if health.is_available:
                return provider
        return None

    # -- External health endpoint -----------------------------------------

    async def health_snapshot(self) -> dict[str, Any]:
        """Return a health snapshot for all registered providers."""
        snapshot: dict[str, Any] = {}
        for provider in self._providers:
            try:
                health = await provider.check_health()
                snapshot[provider.name] = {
                    "status": health.status.value,
                    "is_available": health.is_available,
                    "metrics": {
                        "total_calls": health.metrics.total_calls,
                        "success_count": health.metrics.success_count,
                        "failure_count": health.metrics.failure_count,
                        "success_rate": round(health.metrics.success_rate, 3),
                        "avg_latency_ms": round(health.metrics.avg_latency * 1000, 1),
                        "consecutive_failures": health.metrics.consecutive_failures,
                        "last_success_age": (
                            round(time.monotonic() - health.metrics.last_success, 1)
                            if health.metrics.last_success else None
                        ),
                        "last_failure_age": (
                            round(time.monotonic() - health.metrics.last_failure, 1)
                            if health.metrics.last_failure else None
                        ),
                    },
                }
            except Exception as exc:
                snapshot[provider.name] = {
                    "status": "error",
                    "error": str(exc)[:200],
                }

        return {
            "providers": snapshot,
            "active_provider": (await self.get_provider()).name if self._providers else None,
        }

    # -- Lifecycle --------------------------------------------------------

    async def start_recovery_loop(self) -> None:
        """Background task that periodically re-checks offline providers."""
        while True:
            await asyncio.sleep(RECOVERY_CHECK_INTERVAL)
            try:
                for provider in self._providers:
                    health = await self._check_provider_health(provider)
                    if health.is_available:
                        logger.info(
                            f"Provider '{provider.name}' recovered "
                            f"(status={health.status.value})"
                        )
            except Exception as exc:
                logger.warning(f"Recovery check error: {exc!s:.120}")

    async def close(self) -> None:
        """Close all providers."""
        for provider in self._providers:
            try:
                await provider.close()
            except Exception as exc:
                logger.warning(f"Error closing provider {provider.name}: {exc!s:.100}")


# ---------------------------------------------------------------------------
# Global singleton
# ---------------------------------------------------------------------------

_registry: Optional[ProviderRegistry] = None


def create_registry() -> ProviderRegistry:
    """
    Create and populate the global provider registry.

    Provider priority (first = highest):
      1. YouTube Data API  (official Google API, works everywhere incl. HF Spaces)
      2. InnerTube         (uses www.youtube.com InnerTube API)
      3. Piped             (uses public Piped API instances)
      4. YTMusic           (uses music.youtube.com — local/Render environments)
    """
    global _registry

    from app.services.providers.youtube_data_provider import YouTubeDataAPIProvider
    from app.services.providers.innertube_provider import InnerTubeProvider
    from app.services.providers.piped_provider import PipedProvider
    from app.services.providers.ytmusic_provider import YTMusicProvider

    registry = ProviderRegistry()
    registry.register(YouTubeDataAPIProvider())  # Priority 1: official API, works everywhere
    registry.register(InnerTubeProvider())        # Priority 2: direct InnerTube
    registry.register(PipedProvider())            # Priority 3: Piped proxy
    registry.register(YTMusicProvider())          # Priority 4: ytmusicapi fallback

    _registry = registry
    logger.info(
        "Music provider registry initialized: "
        "youtube-data (primary) → innertube → piped → ytmusic (last resort)"
    )
    return registry


def get_music_provider() -> ProviderRegistry:
    """Return the global provider registry singleton."""
    global _registry
    if _registry is None:
        _registry = create_registry()
    return _registry
