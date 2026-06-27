"""
YTMusicProvider — wraps the existing ytmusicapi implementation.

Keeps all existing retry logic, SSL resilience, and fallback mechanisms.
Acts as a fallback provider when InnerTube is unavailable.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from app.services.providers.base import (
    MusicProvider,
    ProviderHealth,
    ProviderMetrics,
    ProviderStatus,
    COOLDOWN_BASE_SECONDS,
    COOLDOWN_FAILURE_THRESHOLD,
    DEGRADED_LATENCY_THRESHOLD,
)

logger = logging.getLogger("strumm-provider-ytmusic")


class YTMusicProvider(MusicProvider):
    """
    Music provider backed by the existing ytmusicapi wrapper.

    This wraps search_ytmusic_safe() and call_ytmusic_safe() with the
    same interface as other providers. Keeps all existing resilience:
      - TLS 1.2 enforcement
      - Session recreation on SSL failure
      - Exponential backoff
      - Reachability probing
      - Rate-limit fallback client

    Note: This provider may not work on Hugging Face Spaces because
    music.youtube.com is blocked. It serves as a fallback provider.
    """

    def __init__(self) -> None:
        self._metrics = ProviderMetrics()
        self._cooldown_until: Optional[float] = None
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "ytmusic"

    # -- Core interface ---------------------------------------------------

    async def search(
        self, query: str, filter: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """
        Search YTMusic with full resilience.

        Delegates to search_ytmusic_safe() which handles retry, SSL, and
        graceful degradation.
        """
        start = time.monotonic()
        try:
            from app.services.ytmusic import search_ytmusic_safe

            result = await asyncio.to_thread(search_ytmusic_safe, query, filter=filter)
            self._metrics.record_success(time.monotonic() - start)
            return result or []
        except Exception as exc:
            self._metrics.record_failure()
            logger.error(f"YTMusic search failed for '{query}': {exc!s:.150}")
            return []

    async def get_song(self, video_id: str) -> Optional[dict[str, Any]]:
        """
        Get song metadata via YTMusic watch playlist.
        """
        start = time.monotonic()
        try:
            from app.services.ytmusic import call_ytmusic_safe

            watch = await asyncio.to_thread(
                call_ytmusic_safe, "get_watch_playlist",
                videoId=video_id, limit=1,
            )
            if watch and watch.get("tracks"):
                self._metrics.record_success(time.monotonic() - start)
                return watch["tracks"][0]
            self._metrics.record_failure()
            return None
        except Exception as exc:
            self._metrics.record_failure()
            logger.error(f"YTMusic get_song failed for {video_id}: {exc!s:.150}")
            return None

    async def get_album(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get album details and tracks via YTMusic.
        """
        start = time.monotonic()
        try:
            from app.services.ytmusic import call_ytmusic_safe

            album = await asyncio.to_thread(call_ytmusic_safe, "get_album", browse_id)
            if album:
                self._metrics.record_success(time.monotonic() - start)
                return album
            self._metrics.record_failure()
            return None
        except Exception as exc:
            self._metrics.record_failure()
            logger.error(f"YTMusic get_album failed for {browse_id}: {exc!s:.150}")
            return None

    async def get_playlist(
        self, playlist_id: str, limit: Optional[int] = None
    ) -> Optional[dict[str, Any]]:
        """
        Get playlist tracks via YTMusic.
        """
        start = time.monotonic()
        try:
            from app.services.ytmusic import call_ytmusic_safe

            # Strip 'VL' prefix if present
            clean_id = playlist_id
            if clean_id.startswith("VL"):
                clean_id = clean_id[2:]

            playlist = await asyncio.to_thread(
                call_ytmusic_safe, "get_playlist",
                clean_id, limit=limit,
            )
            if playlist:
                self._metrics.record_success(time.monotonic() - start)
                return playlist
            self._metrics.record_failure()
            return None
        except Exception as exc:
            self._metrics.record_failure()
            logger.error(f"YTMusic get_playlist failed for {playlist_id}: {exc!s:.150}")
            return None

    async def get_watch_playlist(
        self, video_id: str, limit: int = 1
    ) -> Optional[dict[str, Any]]:
        """
        Get related tracks (radio mode) via YTMusic.
        """
        start = time.monotonic()
        try:
            from app.services.ytmusic import call_ytmusic_safe

            watch = await asyncio.to_thread(
                call_ytmusic_safe, "get_watch_playlist",
                videoId=video_id, limit=limit,
            )
            if watch:
                self._metrics.record_success(time.monotonic() - start)
                return watch
            self._metrics.record_failure()
            return None
        except Exception as exc:
            self._metrics.record_failure()
            logger.error(f"YTMusic get_watch_playlist failed for {video_id}: {exc!s:.150}")
            return None

    async def get_lyrics(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get lyrics via YTMusic.
        """
        start = time.monotonic()
        try:
            from app.services.ytmusic import call_ytmusic_safe

            lyrics = await asyncio.to_thread(call_ytmusic_safe, "get_lyrics", browse_id)
            if lyrics:
                self._metrics.record_success(time.monotonic() - start)
                return lyrics
            self._metrics.record_failure()
            return None
        except Exception as exc:
            self._metrics.record_failure()
            logger.error(f"YTMusic get_lyrics failed for {browse_id}: {exc!s:.150}")
            return None

    # -- Health -----------------------------------------------------------

    async def check_health(self) -> ProviderHealth:
        """Check YTMusic availability."""
        now = time.monotonic()
        if self._cooldown_until and now < self._cooldown_until:
            return ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=self._metrics,
                is_available=False,
                cooldown_until=self._cooldown_until,
            )

        try:
            from app.services.ytmusic import is_reachable

            reachable = await asyncio.to_thread(is_reachable)
            if reachable is None:
                # No probe has run yet; check reachability actively
                from app.services.ytmusic import search_ytmusic_safe
                test = await asyncio.to_thread(search_ytmusic_safe, "test", filter="songs")
                reachable = len(test) > 0 or test is not None

            if reachable:
                return ProviderHealth(
                    status=ProviderStatus.HEALTHY,
                    metrics=self._metrics,
                    is_available=True,
                )
        except Exception as exc:
            logger.warning(f"YTMusic health check failed: {exc!s:.120}")

        return ProviderHealth(
            status=ProviderStatus.OFFLINE,
            metrics=self._metrics,
            is_available=False,
        )

    async def is_available(self) -> bool:
        health = await self.check_health()
        return health.is_available

    async def close(self) -> None:
        pass
