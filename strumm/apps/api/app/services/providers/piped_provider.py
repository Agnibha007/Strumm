"""
PipedProvider — music provider backed by the Piped API.

Piped is a privacy-friendly YouTube proxy that scrapes YouTube from its own
servers and exposes a clean REST API. This provider works on Hugging Face
Spaces where YouTube's CDN blocks direct connections, because Piped instances
operate from different IP ranges that are not blocked.

Architecture:
  - Multiple public Piped API instances are tried in order (round-robin)
  - Each instance is health-checked before use
  - Automatic fallback if an instance is down or rate-limited

Piped API docs: https://docs.piped.video/docs/api-documentation/
Instance list: https://github.com/TeamPiped/Piped/wiki/Instances
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx

from app.services.providers.base import (
    MusicProvider,
    ProviderHealth,
    ProviderMetrics,
    ProviderStatus,
    COOLDOWN_BASE_SECONDS,
    COOLDOWN_FAILURE_THRESHOLD,
    DEGRADED_LATENCY_THRESHOLD,
)

logger = logging.getLogger("strumm-provider-piped")

# ---------------------------------------------------------------------------
# Piped API instances — ordered by reliability
# ---------------------------------------------------------------------------

PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",       # Official — most reliable
    "https://pipedapi.pwoss.org",
    "https://pipedapi.lunar.icu",
    "https://pipedapi.adminforge.de",
    "https://api.piped.re",
    "https://pipedapi.syncpundit.io",     # Known 403 issues
    "https://pipedapi.moomoo.me",         # Known 502 issues
]

# Search filter mapping
_FILTER_MAP = {
    "songs": "music_songs",
    "albums": "music_albums",
    "artists": "channels",
    "videos": "videos",
}

# Default timeouts
TIMEOUT = 8.0
HEALTH_CHECK_TIMEOUT = 5.0


class PipedProvider(MusicProvider):
    """
    Music provider backed by the Piped API.

    Uses multiple public Piped API instances with automatic failover.
    Works on HF Spaces because Piped scrapes YouTube from its own IPs.
    """

    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            headers={
                "User-Agent": "Strumm/1.0 (Music App)",
                "Accept": "application/json",
            },
            timeout=TIMEOUT,
            follow_redirects=False,  # Do NOT follow redirects — 3xx = unhealthy instance
        )
        self._metrics = ProviderMetrics()
        self._cooldown_until: Optional[float] = None
        self._current_instance_idx = 0
        self._instance_health: dict[str, tuple[float, bool]] = {}

    @property
    def name(self) -> str:
        return "piped"

    # -- Instance management ----------------------------------------------

    def _get_current_instance(self) -> str:
        """Return the current primary instance URL."""
        idx = self._current_instance_idx % len(PIPED_INSTANCES)
        return PIPED_INSTANCES[idx]

    async def _rotate_instance(self) -> str:
        """Rotate to the next healthy instance."""
        max_attempts = len(PIPED_INSTANCES)
        for _ in range(max_attempts):
            self._current_instance_idx = (self._current_instance_idx + 1) % len(PIPED_INSTANCES)
            instance = self._get_current_instance()

            # Check cached health
            cached = self._instance_health.get(instance)
            if cached:
                cached_time, healthy = cached
                if time.monotonic() - cached_time < 30.0 and not healthy:
                    continue  # Skip known-bad instances within cooldown

            # Quick health check
            try:
                resp = await self._http.get(
                    f"{instance}/trending?region=US",
                    timeout=HEALTH_CHECK_TIMEOUT,
                )
                healthy = resp.status_code == 200
                self._instance_health[instance] = (time.monotonic(), healthy)
                if healthy:
                    logger.info(f"Piped: rotated to instance '{instance}'")
                    return instance
            except Exception:
                self._instance_health[instance] = (time.monotonic(), False)
                continue

        # All instances appear down — return current anyway (graceful degradation)
        logger.warning("Piped: all instances appear unhealthy, using current")
        return self._get_current_instance()

    # -- Core HTTP helper -------------------------------------------------

    async def _piped_get(
        self, path: str, params: Optional[dict[str, Any]] = None, timeout: float = TIMEOUT
    ) -> Optional[dict[str, Any] | list]:
        """
        Make a GET request to the Piped API, with automatic instance rotation.

        Any non-200 response (including 3xx redirects) triggers instance rotation.
        Does NOT follow redirects — a redirecting instance is considered unhealthy.

        Returns parsed JSON or None on failure.
        """
        instance = self._get_current_instance()
        url = f"{instance}{path}"

        for attempt in range(3):  # Max 3 attempts (rotate through instances)
            try:
                resp = await self._http.get(url, params=params, timeout=timeout)
                if resp.status_code == 200:
                    try:
                        return resp.json()
                    except (ValueError, TypeError):
                        logger.warning(f"Piped instance {instance} returned non-JSON response")
                        self._mark_unhealthy(instance)
                        instance = await self._rotate_instance()
                        url = f"{instance}{path}"
                        continue

                # Any non-200 means rotate (includes 3xx redirects, 4xx, 5xx)
                logger.warning(
                    f"Piped instance {instance} returned HTTP {resp.status_code} for {path}, rotating"
                )
                self._mark_unhealthy(instance)
                instance = await self._rotate_instance()
                url = f"{instance}{path}"

            except httpx.TimeoutException:
                logger.warning(f"Piped instance {instance} timed out, rotating")
                self._mark_unhealthy(instance)
                instance = await self._rotate_instance()
                url = f"{instance}{path}"
            except httpx.RequestError as exc:
                logger.warning(
                    f"Piped instance {instance} error: {type(exc).__name__}, rotating"
                )
                self._mark_unhealthy(instance)
                instance = await self._rotate_instance()
                url = f"{instance}{path}"

        return None

    def _mark_unhealthy(self, instance: str) -> None:
        """Mark an instance as unhealthy in the cache."""
        self._instance_health[instance] = (time.monotonic(), False)

    # -- Provider interface -----------------------------------------------

    async def search(
        self, query: str, filter: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """
        Search using the Piped API.

        Piped supports music-specific filters: music_songs, music_albums, etc.
        """
        start = time.monotonic()
        piped_filter = _FILTER_MAP.get(filter, "all") if filter else "all"

        try:
            data = await self._piped_get(
                "/search",
                params={"q": query, "filter": piped_filter},
            )

            if not data:
                self._circuit_breaker_failure()
                return []

            # Piped search returns an array of items
            items = data if isinstance(data, list) else data.get("items", [])

            results: list[dict[str, Any]] = []
            for item in items:
                parsed = self._parse_search_item(item, filter)
                if parsed:
                    results.append(parsed)

            self._metrics.record_success(time.monotonic() - start)
            logger.info(
                f"Piped search '{query}' ({piped_filter}): "
                f"{len(results)} results in {(time.monotonic()-start)*1000:.0f}ms"
            )
            return results

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"Piped search failed for '{query}': {exc!s:.150}")
            return []

    async def get_song(self, video_id: str) -> Optional[dict[str, Any]]:
        """Get song metadata via Piped /streams endpoint."""
        start = time.monotonic()

        try:
            data = await self._piped_get(f"/streams/{video_id}")
            if not data:
                self._circuit_breaker_failure()
                return None

            thumbnail = data.get("thumbnailUrl", "")
            uploader = data.get("uploader", "Unknown Artist")
            duration = data.get("duration", 200)

            result = {
                "videoId": video_id,
                "title": data.get("title", "Untitled Track"),
                "artists": [{"name": uploader}],
                "thumbnail": [{"url": thumbnail}],
                "length": duration,
                "album": None,
            }

            self._metrics.record_success(time.monotonic() - start)
            return result

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"Piped get_song failed for {video_id}: {exc!s:.150}")
            return None

    async def get_album(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get album details via Piped.

        Piped doesn't have a native album endpoint for YouTube Music albums.
        However, YT Music album browse IDs (MPRE_...) often correspond to
        YouTube playlists. We try the playlist endpoint as a best-effort.
        """
        start = time.monotonic()
        try:
            # YT Music album browse IDs start with 'MPRE'. These are often
            # accessible as playlists on standard YouTube.
            playlist_id = browse_id
            if browse_id.startswith("MPRE"):
                # Try as a playlist
                result = await self.get_playlist(playlist_id, limit=None)
                if result and result.get("tracks"):
                    # Wrap in album format
                    tracks = result["tracks"]
                    album_name = tracks[0].get("album", {}).get("name", "") if tracks else ""
                    artist = tracks[0].get("artists", [{}])[0].get("name", "Unknown Artist") if tracks else "Unknown Artist"
                    thumb = tracks[0].get("thumbnail", [{}])[0].get("url", "") if tracks else ""

                    album_data = {
                        "title": album_name or "Album",
                        "artists": [{"name": artist}],
                        "thumbnails": [{"url": thumb}],
                        "tracks": tracks,
                    }
                    self._metrics.record_success(time.monotonic() - start)
                    return album_data

            # Not an album we can handle
            logger.info(f"Piped cannot resolve album browse ID '{browse_id}'")
            return None

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"Piped get_album failed for {browse_id}: {exc!s:.150}")
            return None

    async def get_playlist(
        self, playlist_id: str, limit: Optional[int] = None
    ) -> Optional[dict[str, Any]]:
        """Get playlist tracks via Piped /playlists endpoint."""
        start = time.monotonic()

        try:
            # Strip 'VL' prefix if present (YTMusic-style)
            clean_id = playlist_id
            if clean_id.startswith("VL"):
                clean_id = clean_id[2:]

            data = await self._piped_get(f"/playlists/{clean_id}")
            if not data:
                self._circuit_breaker_failure()
                return None

            tracks: list[dict] = []
            related = data.get("relatedStreams", [])

            for item in related:
                url = item.get("url", "")
                vid = url.split("?v=")[-1] if "?v=" in url else ""
                if not vid:
                    continue

                title = item.get("title", "")
                uploader = item.get("uploader", "Unknown Artist")
                thumbnail = item.get("thumbnail", "")
                duration = item.get("duration", 200)

                tracks.append({
                    "videoId": vid,
                    "title": title,
                    "artists": [{"name": uploader}],
                    "thumbnail": [{"url": thumbnail}],
                    "length": duration,
                    "album": {"name": data.get("name", "")} if data.get("name") else None,
                    "duration_seconds": duration,
                })

                if limit and len(tracks) >= limit:
                    break

            self._metrics.record_success(time.monotonic() - start)
            return {"tracks": tracks} if tracks else None

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"Piped get_playlist failed for {playlist_id}: {exc!s:.150}")
            return None

    async def get_watch_playlist(
        self, video_id: str, limit: int = 1
    ) -> Optional[dict[str, Any]]:
        """
        Get related tracks via Piped /streams (relatedStreams).

        The /streams endpoint returns a 'relatedStreams' array which
        serves as the radio/watch-playlist equivalent.
        """
        start = time.monotonic()

        try:
            data = await self._piped_get(f"/streams/{video_id}")
            if not data:
                self._circuit_breaker_failure()
                return None

            tracks: list[dict] = []
            related = data.get("relatedStreams", [])

            for item in related:
                url = item.get("url", "")
                vid = url.split("?v=")[-1] if "?v=" in url else ""
                if not vid or vid == video_id:
                    continue

                title = item.get("title", "")
                uploader = item.get("uploader", "Unknown Artist")
                thumbnail = item.get("thumbnail", "")
                duration = item.get("duration", 200)

                tracks.append({
                    "videoId": vid,
                    "title": title,
                    "artists": [{"name": uploader}],
                    "thumbnail": [{"url": thumbnail}],
                    "length": duration,
                    "album": None,
                })

                if len(tracks) >= limit:
                    break

            result: dict[str, Any] = {"tracks": tracks}

            self._metrics.record_success(time.monotonic() - start)
            return result if tracks else None

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"Piped get_watch_playlist failed for {video_id}: {exc!s:.150}")
            return None

    async def get_lyrics(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get lyrics.

        Piped does not support lyrics. Defer to Lrclib (primary source).
        """
        logger.info("Piped does not support get_lyrics — deferring to Lrclib")
        return None

    # -- Parsing helpers --------------------------------------------------

    @staticmethod
    def _parse_search_item(
        item: dict[str, Any], filter: Optional[str] = None
    ) -> Optional[dict[str, Any]]:
        """Parse a single Piped search result item into unified format."""
        url = item.get("url", "")
        video_id = url.split("?v=")[-1] if "?v=" in url else ""

        title = item.get("title", "")
        uploader = item.get("uploader", "Unknown Artist")
        thumbnail = item.get("thumbnail", "")
        duration = item.get("duration", 0)

        if filter == "albums":
            # Piped album results: may be playlists in search
            playlist_id = url.split("?list=")[-1] if "?list=" in url else video_id
            return {
                "id": playlist_id,
                "title": title,
                "artist": uploader,
                "thumbnail": thumbnail,
                "year": "",
            }

        if filter == "artists":
            # Piped channel results
            channel_id = url.split("/channel/")[-1] if "/channel/" in url else video_id
            return {
                "id": channel_id,
                "name": title,
                "thumbnail": thumbnail,
            }

        # Default: song / video result
        if not video_id:
            return None

        return {
            "videoId": video_id,
            "title": title,
            "artist": uploader,
            "thumbnail": thumbnail,
            "duration": duration or 200,
            "metadata": {"album": ""},
        }

    # -- Health & circuit breaker -----------------------------------------

    async def check_health(self) -> ProviderHealth:
        """Check if Piped API is accessible."""
        now = time.monotonic()
        if self._cooldown_until and now < self._cooldown_until:
            return ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=self._metrics,
                is_available=False,
                cooldown_until=self._cooldown_until,
            )

        try:
            instance = self._get_current_instance()
            start = time.monotonic()
            resp = await self._http.get(
                f"{instance}/trending?region=US",
                timeout=HEALTH_CHECK_TIMEOUT,
            )
            elapsed = time.monotonic() - start

            if resp.status_code == 200:
                status = (
                    ProviderStatus.DEGRADED
                    if elapsed > DEGRADED_LATENCY_THRESHOLD
                    else ProviderStatus.HEALTHY
                )
                return ProviderHealth(
                    status=status,
                    metrics=self._metrics,
                    is_available=True,
                )
        except Exception:
            pass

        # Try rotating
        await self._rotate_instance()
        try:
            instance = self._get_current_instance()
            resp = await self._http.get(
                f"{instance}/trending?region=US",
                timeout=HEALTH_CHECK_TIMEOUT,
            )
            if resp.status_code == 200:
                return ProviderHealth(
                    status=ProviderStatus.HEALTHY,
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
                300.0,
            )
            self._cooldown_until = time.monotonic() + cooldown
            logger.warning(
                f"Piped: {self._metrics.consecutive_failures} consecutive failures, "
                f"cooling down for {cooldown:.0f}s"
            )

    async def close(self) -> None:
        await self._http.aclose()
