"""
YouTubeDataAPIProvider — music provider backed by the official YouTube Data API v3.

This provider uses Google's official API infrastructure, which is NOT subject to
the same CDN blocking that affects direct YouTube connections (ytmusicapi, InnerTube,
yt-dlp) on cloud platforms like Hugging Face Spaces.

Requires a Google Cloud API key with the YouTube Data API v3 enabled.
Set the YOUTUBE_DATA_API_KEY environment variable.

Quota: 10,000 units/day free.
  - search.list:    1 unit (capped at 100 calls/day)
  - videos.list:    1 unit
  - playlistItems.list: 1 unit

YouTube Data API docs: https://developers.google.com/youtube/v3/docs
"""

from __future__ import annotations

import logging
import os
import re
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

logger = logging.getLogger("strumm-provider-youtube-data")


def _parse_iso8601_duration(duration: str) -> int:
    """Parse ISO 8601 duration string (e.g. 'PT1M30S') to seconds."""
    if not duration:
        return 200
    match = re.match(
        r"PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?",
        duration,
    )
    if not match:
        return 200
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    return hours * 3600 + minutes * 60 + seconds


def _get_hq_thumbnail(thumbnails: dict) -> str:
    """Extract the highest quality thumbnail URL."""
    for quality in ("maxres", "high", "medium", "default"):
        thumb = thumbnails.get(quality, {})
        url = thumb.get("url", "")
        if url:
            return url
    return ""


class YouTubeDataAPIProvider(MusicProvider):
    """
    Music provider backed by the official YouTube Data API v3.

    Requires YOUTUBE_DATA_API_KEY environment variable.
    Works on all platforms including HF Spaces.

    Limitations:
      - lyrics: Not supported (defer to Lrclib)
      - albums: Not directly supported (YouTube Data API doesn't have album concept)
      - watch playlist / radio: Approximated via relatedToVideoId search
    """

    def __init__(self) -> None:
        self._api_key: Optional[str] = None
        self._youtube: Any = None
        self._metrics = ProviderMetrics()
        self._cooldown_until: Optional[float] = None

    @property
    def name(self) -> str:
        return "youtube-data"

    # -- Client initialization --------------------------------------------

    def _ensure_client(self) -> bool:
        """Lazy-initialize the YouTube API client. Returns True if ready."""
        if self._youtube is not None:
            return True

        self._api_key = os.getenv("YOUTUBE_DATA_API_KEY")
        if not self._api_key:
            logger.warning("YOUTUBE_DATA_API_KEY not set — YouTube Data API unavailable")
            return False

        try:
            from googleapiclient.discovery import build

            self._youtube = build("youtube", "v3", developerKey=self._api_key, cache_discovery=False)
            logger.info("YouTube Data API v3 client initialized")
            return True
        except Exception as exc:
            logger.error(f"Failed to initialize YouTube Data API client: {exc!s:.150}")
            return False

    # -- Core interface ---------------------------------------------------

    async def search(
        self, query: str, filter: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """Search using the YouTube Data API."""
        if not self._ensure_client():
            return []

        start = time.monotonic()
        try:
            # Map our filters to YouTube API types
            yt_type = "video"
            if filter == "channels":
                yt_type = "channel"
            elif filter == "playlists":
                yt_type = "playlist"

            # Step 1: Search
            search_kwargs = {
                "q": query,
                "part": "snippet",
                "type": yt_type,
                "maxResults": 20,
            }

            search_response = await self._call_api(
                self._youtube.search().list, **search_kwargs
            )
            if not search_response:
                self._circuit_breaker_failure()
                return []

            items = search_response.get("items", [])
            if not items:
                return []

            # Step 2: If video search, get durations via videos.list
            results: list[dict[str, Any]] = []
            if yt_type == "video":
                video_ids = [
                    item["id"]["videoId"]
                    for item in items
                    if item.get("id", {}).get("videoId")
                ]
                durations = await self._fetch_durations(video_ids)

                for item in items:
                    vid = item.get("id", {}).get("videoId")
                    if not vid:
                        continue
                    snippet = item.get("snippet", {})
                    thumb = _get_hq_thumbnail(snippet.get("thumbnails", {}))
                    duration = durations.get(vid, 200)

                    results.append({
                        "videoId": vid,
                        "title": snippet.get("title", ""),
                        "artist": snippet.get("channelTitle", "Unknown Artist"),
                        "thumbnail": thumb,
                        "duration": duration,
                        "metadata": {"album": ""},
                    })

            elif yt_type == "channel":
                for item in items:
                    channel_id = item.get("snippet", {}).get("channelId", "")
                    snippet = item.get("snippet", {})
                    thumb = _get_hq_thumbnail(snippet.get("thumbnails", {}))
                    results.append({
                        "id": channel_id,
                        "name": snippet.get("title", ""),
                        "thumbnail": thumb,
                    })

            self._metrics.record_success(time.monotonic() - start)
            logger.info(
                f"YouTube Data API search '{query}' ({filter or 'all'}): "
                f"{len(results)} results ({len(items)} items) "
                f"in {(time.monotonic()-start)*1000:.0f}ms"
            )
            return results

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"YouTube Data API search failed for '{query}': {exc!s:.150}")
            return []

    async def get_song(self, video_id: str) -> Optional[dict[str, Any]]:
        """Get song metadata via videos.list."""
        if not self._ensure_client():
            return None

        start = time.monotonic()
        try:
            response = await self._call_api(
                self._youtube.videos().list,
                id=video_id,
                part="snippet,contentDetails",
            )
            if not response or not response.get("items"):
                self._circuit_breaker_failure()
                return None

            video = response["items"][0]
            snippet = video.get("snippet", {})
            content = video.get("contentDetails", {})
            thumb = _get_hq_thumbnail(snippet.get("thumbnails", {}))
            duration = _parse_iso8601_duration(content.get("duration", ""))

            result = {
                "videoId": video_id,
                "title": snippet.get("title", ""),
                "artists": [{"name": snippet.get("channelTitle", "Unknown Artist")}],
                "thumbnail": [{"url": thumb}],
                "length": duration,
                "album": None,
            }

            self._metrics.record_success(time.monotonic() - start)
            return result

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"YouTube Data API get_song failed for {video_id}: {exc!s:.150}")
            return None

    async def get_album(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get album details.

        YouTube Data API v3 doesn't have an album concept.
        If the browse_id is a YouTube Music album (MPRE...), we cannot resolve it.
        """
        logger.info("YouTube Data API does not support albums — deferring")
        return None

    async def get_playlist(
        self, playlist_id: str, limit: Optional[int] = None
    ) -> Optional[dict[str, Any]]:
        """Get playlist items via playlistItems.list."""
        if not self._ensure_client():
            return None

        start = time.monotonic()
        try:
            max_results = min(limit or 50, 50)

            response = await self._call_api(
                self._youtube.playlistItems().list,
                playlistId=playlist_id,
                part="snippet,contentDetails",
                maxResults=max_results,
            )
            if not response or not response.get("items"):
                self._circuit_breaker_failure()
                return None

            tracks: list[dict] = []
            for item in response.get("items", []):
                snippet = item.get("snippet", {})
                content = item.get("contentDetails", {})
                vid = content.get("videoId", "") or snippet.get("resourceId", {}).get("videoId", "")
                if not vid:
                    continue

                thumb = _get_hq_thumbnail(snippet.get("thumbnails", {}))
                # Duration not available in playlistItems — need separate videos.list call
                # We'll batch-fetch durations for efficiency
                tracks.append({
                    "videoId": vid,
                    "title": snippet.get("title", ""),
                    "artists": [{"name": snippet.get("videoOwnerChannelTitle", "Unknown Artist")}],
                    "thumbnail": [{"url": thumb}],
                    "length": 200,  # Will be updated if we fetch durations
                    "album": {"name": snippet.get("playlistTitle", "")} if snippet.get("playlistTitle") else None,
                    "duration_seconds": 200,
                })

            # Batch-fetch durations
            if tracks:
                video_ids = [t["videoId"] for t in tracks]
                durations = await self._fetch_durations(video_ids)
                for track in tracks:
                    dur = durations.get(track["videoId"], 200)
                    track["length"] = dur
                    track["duration_seconds"] = dur

            self._metrics.record_success(time.monotonic() - start)
            return {"tracks": tracks} if tracks else None

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(f"YouTube Data API get_playlist failed for {playlist_id}: {exc!s:.150}")
            return None

    async def get_watch_playlist(
        self, video_id: str, limit: int = 1
    ) -> Optional[dict[str, Any]]:
        """
        Get related tracks via search with relatedToVideoId.

        This is an approximation — the YouTube Data API doesn't have a
        dedicated 'watch playlist' endpoint like ytmusicapi.
        """
        if not self._ensure_client():
            return None

        start = time.monotonic()
        try:
            response = await self._call_api(
                self._youtube.search().list,
                relatedToVideoId=video_id,
                part="snippet",
                type="video",
                maxResults=min(limit + 5, 50),  # Fetch extra to filter seed
            )
            if not response or not response.get("items"):
                self._circuit_breaker_failure()
                return None

            tracks: list[dict] = []
            video_ids_for_duration: list[str] = []

            for item in response.get("items", []):
                vid = item.get("id", {}).get("videoId")
                if not vid or vid == video_id:
                    continue

                snippet = item.get("snippet", {})
                thumb = _get_hq_thumbnail(snippet.get("thumbnails", {}))

                tracks.append({
                    "videoId": vid,
                    "title": snippet.get("title", ""),
                    "artists": [{"name": snippet.get("channelTitle", "Unknown Artist")}],
                    "thumbnail": [{"url": thumb}],
                    "length": 200,
                    "album": None,
                })
                video_ids_for_duration.append(vid)

                if len(tracks) >= limit:
                    break

            # Batch-fetch durations
            if tracks:
                durations = await self._fetch_durations(video_ids_for_duration)
                for track in tracks:
                    dur = durations.get(track["videoId"], 200)
                    track["length"] = dur

            self._metrics.record_success(time.monotonic() - start)
            return {"tracks": tracks} if tracks else None

        except Exception as exc:
            self._circuit_breaker_failure()
            logger.error(
                f"YouTube Data API get_watch_playlist failed for {video_id}: {exc!s:.150}"
            )
            return None

    async def get_lyrics(self, browse_id: str) -> Optional[dict[str, Any]]:
        """
        Get lyrics.

        YouTube Data API v3 does not support lyrics. Defer to Lrclib.
        """
        logger.info("YouTube Data API does not support get_lyrics — deferring to Lrclib")
        return None

    # -- API helpers ------------------------------------------------------

    async def _call_api(self, method, **kwargs) -> Optional[dict]:
        """
        Execute a YouTube Data API call with error handling.

        Runs synchronous googleapiclient call in a thread to avoid blocking.
        """
        import asyncio

        try:
            request = method(**kwargs)
            response = await asyncio.to_thread(request.execute)
            return response
        except Exception as exc:
            err_str = str(exc).lower()
            if "quota" in err_str or "dailyLimitExceeded" in err_str:
                logger.warning("YouTube Data API: Quota exceeded!")
                self._cooldown_until = time.monotonic() + 3600  # Back off 1 hour
            elif "key" in err_str and "invalid" in err_str:
                logger.error("YouTube Data API: Invalid API key!")
            else:
                logger.warning(f"YouTube Data API call failed: {type(exc).__name__}: {exc!s:.200}")
            return None

    async def _fetch_durations(self, video_ids: list[str]) -> dict[str, int]:
        """
        Batch-fetch durations for a list of video IDs.

        YouTube Data API allows up to 50 IDs per videos.list call.
        """
        if not video_ids or not self._youtube:
            return {}

        durations: dict[str, int] = {}

        # Process in batches of 50
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i : i + 50]
            response = await self._call_api(
                self._youtube.videos().list,
                id=",".join(batch),
                part="contentDetails",
            )
            if response and response.get("items"):
                for video in response["items"]:
                    vid = video.get("id", "")
                    content = video.get("contentDetails", {})
                    durations[vid] = _parse_iso8601_duration(content.get("duration", ""))

        return durations

    # -- Health & circuit breaker -----------------------------------------

    async def check_health(self) -> ProviderHealth:
        """Check if the YouTube Data API is accessible and has a valid key."""
        now = time.monotonic()
        if self._cooldown_until and now < self._cooldown_until:
            return ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=self._metrics,
                is_available=False,
                cooldown_until=self._cooldown_until,
            )

        if not os.getenv("YOUTUBE_DATA_API_KEY"):
            return ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=self._metrics,
                is_available=False,
            )

        if not self._ensure_client():
            return ProviderHealth(
                status=ProviderStatus.OFFLINE,
                metrics=self._metrics,
                is_available=False,
            )

        # Quick probe: search for a common term
        try:
            import asyncio

            start = time.monotonic()
            request = self._youtube.search().list(
                q="test", part="snippet", type="video", maxResults=1
            )
            response = await asyncio.to_thread(request.execute)
            elapsed = time.monotonic() - start

            if response and "items" in response:
                status = (
                    ProviderStatus.DEGRADED
                    if elapsed > DEGRADED_LATENCY_THRESHOLD
                    else ProviderStatus.HEALTHY
                )
                return ProviderHealth(
                    status=status, metrics=self._metrics, is_available=True
                )
        except Exception as exc:
            err_str = str(exc).lower()
            if "quota" in err_str or "dailyLimitExceeded" in err_str:
                self._cooldown_until = time.monotonic() + 3600

        return ProviderHealth(
            status=ProviderStatus.OFFLINE,
            metrics=self._metrics,
            is_available=False,
        )

    async def is_available(self) -> bool:
        health = await self.check_health()
        return health.is_available

    def _circuit_breaker_failure(self) -> None:
        self._metrics.record_failure()
        if self._metrics.consecutive_failures >= COOLDOWN_FAILURE_THRESHOLD:
            cooldown = min(
                COOLDOWN_BASE_SECONDS * (2 ** (self._metrics.consecutive_failures - COOLDOWN_FAILURE_THRESHOLD)),
                300.0,
            )
            self._cooldown_until = time.monotonic() + cooldown

    async def close(self) -> None:
        pass
