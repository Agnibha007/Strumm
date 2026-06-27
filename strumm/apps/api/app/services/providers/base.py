"""
Music Provider — abstract base class and shared types.

Every provider (InnerTube, YTMusic, etc.) implements MusicProvider and
returns results in a uniform schema that mirrors what ytmusicapi returns,
so existing route handlers work without modification.
"""

from __future__ import annotations

import time
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger("strumm-provider")


# ---------------------------------------------------------------------------
# Provider status
# ---------------------------------------------------------------------------

class ProviderStatus(Enum):
    """Health status of a music provider."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"  # Working but with high latency or intermittent failures
    OFFLINE = "offline"     # Currently unavailable


# ---------------------------------------------------------------------------
# Per-provider health & metrics
# ---------------------------------------------------------------------------

@dataclass
class ProviderMetrics:
    """Rolling metrics for a single provider instance."""
    total_calls: int = 0
    success_count: int = 0
    failure_count: int = 0
    latency_total: float = 0.0
    last_success: Optional[float] = None
    last_failure: Optional[float] = None
    consecutive_failures: int = 0
    max_consecutive_failures: int = 0

    @property
    def success_rate(self) -> float:
        if self.total_calls == 0:
            return 1.0
        return self.success_count / self.total_calls

    @property
    def avg_latency(self) -> float:
        if self.success_count == 0:
            return 0.0
        return self.latency_total / self.success_count

    def record_success(self, elapsed: float) -> None:
        self.total_calls += 1
        self.success_count += 1
        self.latency_total += elapsed
        self.last_success = time.monotonic()
        self.consecutive_failures = 0

    def record_failure(self) -> None:
        self.total_calls += 1
        self.failure_count += 1
        self.last_failure = time.monotonic()
        self.consecutive_failures += 1
        if self.consecutive_failures > self.max_consecutive_failures:
            self.max_consecutive_failures = self.consecutive_failures


@dataclass
class ProviderHealth:
    """Computed health snapshot for a provider."""
    status: ProviderStatus
    metrics: ProviderMetrics
    is_available: bool
    cooldown_until: Optional[float] = None

    @property
    def name(self) -> str:
        return ""


# ---------------------------------------------------------------------------
# Provider Errors
# ---------------------------------------------------------------------------

class ProviderError(Exception):
    """Base exception for all provider errors."""
    pass


class ProviderUnavailableError(ProviderError):
    """The provider is offline or unreachable."""
    pass


class ProviderRateLimitedError(ProviderError):
    """The provider has rate-limited us."""
    pass


class ProviderNoResultsError(ProviderError):
    """The provider returned no results (not an error, just empty)."""
    pass


# ---------------------------------------------------------------------------
# Cooldown / circuit-breaker config
# ---------------------------------------------------------------------------

COOLDOWN_BASE_SECONDS = 15.0       # first cooldown
COOLDOWN_MAX_SECONDS = 300.0       # max 5 minutes
COOLDOWN_FAILURE_THRESHOLD = 3     # consecutive failures before cooldown
DEGRADED_LATENCY_THRESHOLD = 5.0   # seconds


# ---------------------------------------------------------------------------
# Abstract base class
# ---------------------------------------------------------------------------

class MusicProvider(ABC):
    """
    Abstract music metadata provider.

    All methods return data in the same schema that ytmusicapi uses, so
    route handlers never need to know which provider they're talking to.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable provider name (e.g. 'innertube', 'ytmusic')."""
        ...

    @abstractmethod
    async def search(self, query: str, filter: Optional[str] = None) -> list[dict[str, Any]]:
        """
        Search for songs / albums / artists.

        Args:
            query: Search string.
            filter: One of 'songs', 'albums', 'artists', or None.

        Returns:
            List of result dicts in the same schema as ytmusicapi.search().
        """
        ...

    @abstractmethod
    async def get_song(self, video_id: str) -> Optional[dict[str, Any]]:
        """
        Get metadata for a single song/video.

        Returns a dict matching ytmusicapi.get_watch_playlist() track format,
        or None if not found.
        """
        ...

    @abstractmethod
    async def get_album(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get album details and tracks.

        Returns a dict matching ytmusicapi.get_album() format,
        or None if not found.
        """
        ...

    @abstractmethod
    async def get_playlist(self, playlist_id: str, limit: Optional[int] = None) -> Optional[dict[str, Any]]:
        """
        Get playlist tracks.

        Args:
            playlist_id: YouTube playlist ID (e.g. 'PL...').
            limit: Max tracks to return, or None for all.

        Returns a dict matching ytmusicapi.get_playlist() format,
        or None if not found.
        """
        ...

    @abstractmethod
    async def get_watch_playlist(self, video_id: str, limit: int = 1) -> Optional[dict[str, Any]]:
        """
        Get related tracks for a video (radio/watch-playlist).

        Returns a dict with 'tracks' list and optional 'lyrics' browseId,
        matching ytmusicapi.get_watch_playlist() format,
        or None if not found.
        """
        ...

    @abstractmethod
    async def get_lyrics(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get lyrics for a song.

        Args:
            browse_id: The lyrics browse ID obtained from get_watch_playlist().

        Returns a dict matching ytmusicapi.get_lyrics() format,
        or None if not found.
        """
        ...

    # -- Health ------------------------------------------------------------

    @abstractmethod
    async def check_health(self) -> ProviderHealth:
        """Return current health snapshot for this provider."""
        ...

    @abstractmethod
    async def is_available(self) -> bool:
        """Quick check — can this provider serve requests right now?"""
        ...


# ---------------------------------------------------------------------------
# Response schema helpers
# ---------------------------------------------------------------------------

# These describe the dict shapes that every provider must return.
# They match ytmusicapi's response format for backwards compatibility.

SONG_SCHEMA_KEYS = {"videoId", "title", "artist", "thumbnail", "duration", "metadata"}
ALBUM_SCHEMA_KEYS = {"id", "title", "artist", "thumbnail", "year"}
ARTIST_SCHEMA_KEYS = {"id", "name", "thumbnail"}
TRACK_SCHEMA_KEYS = {"videoId", "title", "artists", "thumbnail", "length", "album"}


def make_song_dict(
    video_id: str,
    title: str,
    artist: str,
    thumbnail: str,
    duration: int,
    album: str = "",
) -> dict[str, Any]:
    """Build a standardized song result dict."""
    return {
        "videoId": video_id,
        "title": title,
        "artist": artist,
        "thumbnail": thumbnail,
        "duration": duration,
        "metadata": {"album": album},
    }


def make_track_dict(
    video_id: str,
    title: str,
    artist_name: str,
    thumbnail: str,
    duration: int,
    album: str = "",
) -> dict[str, Any]:
    """Build a standardized track dict (for watch-playlist / radio)."""
    return {
        "videoId": video_id,
        "title": title,
        "artists": [{"name": artist_name}],
        "thumbnail": [{"url": thumbnail}],
        "length": duration,
        "album": {"name": album} if album else None,
    }


def make_album_dict(
    browse_id: str,
    title: str,
    artist: str,
    thumbnail: str,
    year: str = "",
) -> dict[str, Any]:
    """Build a standardized album result dict."""
    return {
        "id": browse_id,
        "title": title,
        "artist": artist,
        "thumbnail": thumbnail,
        "year": year,
    }


def make_artist_dict(
    browse_id: str,
    name: str,
    thumbnail: str,
) -> dict[str, Any]:
    """Build a standardized artist result dict."""
    return {
        "id": browse_id,
        "name": name,
        "thumbnail": thumbnail,
    }
