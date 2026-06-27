"""
InnerTubeProvider — high-level provider wrapping InnerTubeClient.

Targets www.youtube.com via the InnerTube API (WEB client), bypassing
music.youtube.com entirely. This is the DEFAULT provider because it
works on Hugging Face Spaces where music.youtube.com is unreachable.
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
from app.services.providers.innertube_client import (
    InnerTubeClient,
    extract_search_results,
    extract_player_song,
    extract_playlist,
    extract_album,
    extract_watch_playlist,
    WEB_CLIENT_CONTEXT,
    MUSIC_CLIENT_CONTEXT,
)

logger = logging.getLogger("strumm-provider-innertube")

# Search param values from YouTube Music / InnerTube
_SEARCH_PARAMS = {
    "songs": "EgWKAQIIAWoKEAoQCRADEAAyBA",
    "albums": "EgWKAQIICmoKEAoQCRADEAAyBA",
    "artists": "EgWKAQIgAWoKEAoQCRADEAAyBA",
    "videos": "EgIQAQ%3D%3D",
}


class InnerTubeProvider(MusicProvider):
    """
    Music provider backed by YouTube's InnerTube API (WEB client).

    All requests go to www.youtube.com/youtubei/v1/... which is
    *not* blocked on Hugging Face Spaces (unlike music.youtube.com).
    """

    def __init__(self) -> None:
        self._client = InnerTubeClient()
        self._metrics = ProviderMetrics()
        self._cooldown_until: Optional[float] = None
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "innertube"

    # -- Core interface ---------------------------------------------------

    async def search(
        self, query: str, filter: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """
        Search for songs, albums, or artists.

        Uses WEB client context — results are standard YouTube videos,
        not YouTube Music specific. We parse them into the same schema.
        """
        params = _SEARCH_PARAMS.get(filter) if filter else None
        start = time.monotonic()

        try:
            # Try WEB_MUSIC client first for better music results; fall back to WEB
            data = await self._client.search(query, params=params, client_context=MUSIC_CLIENT_CONTEXT)
            if not data:
                data = await self._client.search(query, params=params, client_context=WEB_CLIENT_CONTEXT)

            if not data:
                self._circuit_breaker_failure()
                logger.warning(f"InnerTube search returned no data for '{query}'")
                return []

            results = extract_search_results(data, filter=filter)
            self._metrics.record_success(time.monotonic() - start)
            logger.info(
                f"InnerTube search '{query}' ({filter or 'all'}): "
                f"{len(results)} results in {(time.monotonic()-start)*1000:.0f}ms"
            )
            return results

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(
                f"InnerTube search failed for '{query}': {type(exc).__name__}: {exc!s:.150}"
            )
            return []

    async def get_song(self, video_id: str) -> Optional[dict[str, Any]]:
        """Get metadata for a single video."""
        start = time.monotonic()

        try:
            data = await self._client.player(video_id)
            if not data:
                self._circuit_breaker_failure()
                return None

            result = extract_player_song(data)
            self._metrics.record_success(time.monotonic() - start)
            return result

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"InnerTube get_song failed for {video_id}: {exc!s:.150}")
            return None

    async def get_album(self, browse_id: str) -> Optional[dict[str, Any]]:
        """Get album details and tracks."""
        start = time.monotonic()

        try:
            # Try WEB_MUSIC first for albums, fall back to WEB
            data = await self._client.browse(browse_id, client_context=MUSIC_CLIENT_CONTEXT)
            if not data:
                data = await self._client.browse(browse_id, client_context=WEB_CLIENT_CONTEXT)

            if not data:
                self._circuit_breaker_failure()
                return None

            result = extract_album(data)
            self._metrics.record_success(time.monotonic() - start)
            return result

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"InnerTube get_album failed for {browse_id}: {exc!s:.150}")
            return None

    async def get_playlist(
        self, playlist_id: str, limit: Optional[int] = None
    ) -> Optional[dict[str, Any]]:
        """Get playlist tracks."""
        start = time.monotonic()

        try:
            # YouTube playlists use 'VL' prefix in browseId
            browse_id = f"VL{playlist_id}" if not playlist_id.startswith("VL") else playlist_id
            data = await self._client.browse(browse_id, client_context=MUSIC_CLIENT_CONTEXT)
            if not data:
                data = await self._client.browse(browse_id, client_context=WEB_CLIENT_CONTEXT)

            if not data:
                self._circuit_breaker_failure()
                return None

            result = extract_playlist(data, limit=limit)
            self._metrics.record_success(time.monotonic() - start)
            return result

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"InnerTube get_playlist failed for {playlist_id}: {exc!s:.150}")
            return None

    async def get_watch_playlist(
        self, video_id: str, limit: int = 1
    ) -> Optional[dict[str, Any]]:
        """
        Get related tracks for a video (radio mode).

        Uses /next endpoint. Tries WEB_MUSIC first for better music results,
        falls back to WEB.
        """
        start = time.monotonic()

        try:
            data = await self._client.next(video_id, client_context=MUSIC_CLIENT_CONTEXT)
            if not data:
                data = await self._client.next(video_id, client_context=WEB_CLIENT_CONTEXT)

            if not data:
                self._circuit_breaker_failure()
                return None

            result = extract_watch_playlist(data, limit=limit)
            self._metrics.record_success(time.monotonic() - start)
            return result

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"InnerTube get_watch_playlist failed for {video_id}: {exc!s:.150}")
            return None

    async def get_lyrics(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get lyrics for a song.

        Note: InnerTube WEB client does not support the lyrics browse endpoint
        the same way as WEB_MUSIC. This provider always returns None for lyrics,
        deferring to the Lrclib lyrics source in the route handler.
        """
        # InnerTube WEB client cannot fetch lyrics.
        # The lyrics route already uses Lrclib as primary source,
        # so this is handled gracefully.
        logger.info("InnerTube does not support get_lyrics (WEB client) — deferring to Lrclib")
        return None

    # -- Health -----------------------------------------------------------

    async def check_health(self) -> ProviderHealth:
        """Run a lightweight health check."""
        # Check if we're in cooldown
        now = time.monotonic()
        if self._cooldown_until and now < self._cooldown_until:
            return ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=self._metrics,
                is_available=False,
                cooldown_until=self._cooldown_until,
            )

        # Quick probe: search for a common term
        start = time.monotonic()
        try:
            data = await self._client.search("test", client_context=WEB_CLIENT_CONTEXT)
            if data and "contents" in data:
                elapsed = time.monotonic() - start
                if elapsed > DEGRADED_LATENCY_THRESHOLD:
                    status = ProviderStatus.DEGRADED
                else:
                    status = ProviderStatus.HEALTHY
                return ProviderHealth(
                    status=status,
                    metrics=self._metrics,
                    is_available=True,
                )
        except Exception:
            pass

        return ProviderHealth(
            status=ProviderStatus.OFFLINE,
            metrics=self._metrics,
            is_available=False,
        )

    async def is_available(self) -> bool:
        health = await self.check_health()
        return health.is_available

    def _circuit_breaker_failure(self) -> None:
        """Record a failure and potentially enter cooldown."""
        self._metrics.record_failure()
        if self._metrics.consecutive_failures >= COOLDOWN_FAILURE_THRESHOLD:
            cooldown = min(
                COOLDOWN_BASE_SECONDS * (2 ** (self._metrics.consecutive_failures - COOLDOWN_FAILURE_THRESHOLD)),
                300.0,  # max 5 min
            )
            self._cooldown_until = time.monotonic() + cooldown
            logger.warning(
                f"InnerTube: {self._metrics.consecutive_failures} consecutive failures, "
                f"cooling down for {cooldown:.0f}s"
            )

    async def close(self) -> None:
        await self._client.close()
