"""
Low-level InnerTube HTTP client.

Targets www.youtube.com/youtubei/v1/... (NOT music.youtube.com),
using the WEB client context to avoid the HF Spaces music.youtube.com blockade.

Architecture:
    InnerTubeClient  → raw HTTP calls to youtube.com InnerTube API
    InnerTubeProvider → higher-level provider that wraps InnerTubeClient
                        and returns uniformly-parsed results

References:
    https://github.com/tombulled/innertube
    https://tyrrrz.me/blog/reverse-engineering-youtube-revisited
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Optional

import httpx

logger = logging.getLogger("strumm-innertube")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INNERTUBE_API_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w"
INNERTUBE_BASE_URL = "https://www.youtube.com/youtubei/v1"

# Chrome-equivalent client context — tells YouTube we're a real browser
WEB_CLIENT_CONTEXT = {
    "client": {
        "clientName": "WEB",
        "clientVersion": "2.20250101.01.00",
        "platform": "DESKTOP",
        "hl": "en",
        "gl": "US",
        "utcOffsetMinutes": 0,
    },
}

MUSIC_CLIENT_CONTEXT = {
    "client": {
        "clientName": "WEB_MUSIC",
        "clientVersion": "1.20250101.01.00",
        "platform": "DESKTOP",
        "hl": "en",
        "gl": "US",
        "utcOffsetMinutes": 0,
    },
}

# Timeouts
CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 5.0

# Retry config
MAX_ATTEMPTS = 2
BACKOFF = 0.5  # seconds


# ---------------------------------------------------------------------------
# InnerTube HTTP client
# ---------------------------------------------------------------------------

class InnerTubeClient:
    """
    Low-level HTTP client for YouTube's InnerTube API.

    Usage:
        client = InnerTubeClient()
        data = await client.search("lofi beats")
        player = await client.player("dQw4w9WgXcQ")
    """

    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/json",
            },
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            follow_redirects=True,
        )

    async def close(self) -> None:
        await self._http.aclose()

    # -- Core endpoints ---------------------------------------------------

    async def search(
        self,
        query: str,
        params: Optional[str] = None,
        client_context: Optional[dict] = None,
    ) -> Optional[dict[str, Any]]:
        """POST /search — execute a search query."""
        body = {
            "context": client_context or WEB_CLIENT_CONTEXT,
            "query": query,
        }
        if params:
            body["params"] = params
        return await self._post("search", body)

    async def player(
        self,
        video_id: str,
        client_context: Optional[dict] = None,
    ) -> Optional[dict[str, Any]]:
        """POST /player — get video metadata."""
        body = {
            "context": client_context or WEB_CLIENT_CONTEXT,
            "videoId": video_id,
        }
        return await self._post("player", body)

    async def browse(
        self,
        browse_id: str,
        params: Optional[str] = None,
        client_context: Optional[dict] = None,
        continuation: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """
        POST /browse — fetch a page (playlist, album, channel, etc.).

        Args:
            browse_id: The browse ID (e.g. 'VLPL...' for playlists, 'MPREb_...' for albums).
            params: Optional search/browse params.
            client_context: Client context override.
            continuation: Continuation token for pagination.
        """
        body: dict[str, Any] = {
            "context": client_context or WEB_CLIENT_CONTEXT,
        }
        if browse_id:
            body["browseId"] = browse_id
        if params:
            body["params"] = params
        if continuation:
            body["continuation"] = continuation
        return await self._post("browse", body)

    async def next(
        self,
        video_id: Optional[str] = None,
        playlist_id: Optional[str] = None,
        client_context: Optional[dict] = None,
        continuation: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """
        POST /next — get related content / next results.

        Used for watch-playlist (radio) and related videos.
        """
        body: dict[str, Any] = {
            "context": client_context or WEB_CLIENT_CONTEXT,
        }
        if video_id:
            body["videoId"] = video_id
        if playlist_id:
            body["playlistId"] = playlist_id
        if continuation:
            body["continuation"] = continuation
        return await self._post("next", body)

    # -- Low-level POST ---------------------------------------------------

    async def _post(self, endpoint: str, body: dict) -> Optional[dict[str, Any]]:
        """Execute a POST to the InnerTube API with retry."""
        url = f"{INNERTUBE_BASE_URL}/{endpoint}?key={INNERTUBE_API_KEY}"

        last_error: Optional[Exception] = None

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = await self._http.post(url, json=body)
                response.raise_for_status()
                return response.json()
            except httpx.TimeoutException as exc:
                last_error = exc
                logger.warning(
                    f"InnerTube {endpoint} timeout (attempt {attempt}/{MAX_ATTEMPTS})"
                )
            except httpx.HTTPStatusError as exc:
                last_error = exc
                if attempt < MAX_ATTEMPTS and exc.response.status_code in (429, 503, 502):
                    logger.warning(
                        f"InnerTube {endpoint} HTTP {exc.response.status_code} "
                        f"(attempt {attempt}/{MAX_ATTEMPTS})"
                    )
                else:
                    # Non-retryable or last attempt
                    logger.error(
                        f"InnerTube {endpoint} HTTP {exc.response.status_code}: "
                        f"{exc.response.text[:200]}"
                    )
                    return None
            except httpx.RequestError as exc:
                last_error = exc
                logger.warning(
                    f"InnerTube {endpoint} request failed (attempt {attempt}/{MAX_ATTEMPTS}): "
                    f"{type(exc).__name__}: {exc!s:.120}"
                )

            if attempt < MAX_ATTEMPTS:
                await self._sleep(BACKOFF * attempt)

        logger.error(
            f"InnerTube {endpoint} failed after {MAX_ATTEMPTS} attempts: "
            f"{type(last_error).__name__}: {last_error!s:.200}"
        )
        return None

    @staticmethod
    async def _sleep(seconds: float) -> None:
        """Sleep helper."""
        await asyncio.sleep(seconds)


# ---------------------------------------------------------------------------
# InnerTube response parsers
# ---------------------------------------------------------------------------

def extract_search_results(
    data: Optional[dict],
    filter: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Extract and parse InnerTube search results into ytmusicapi-compatible format.

    Handles the deeply-nested InnerTube response structure.
    """
    if not data:
        return []

    results: list[dict[str, Any]] = []

    try:
        contents = data.get("contents", {})
        two_column = contents.get("twoColumnSearchResultsRenderer", {})
        primary = two_column.get("primaryContents", {})
        section_list = primary.get("sectionListRenderer", {})
        sections = section_list.get("contents", [])

        for section in sections:
            item_section = section.get("itemSectionRenderer", {})
            items = item_section.get("contents", [])
            for item in items:
                parsed = _parse_search_item(item, filter)
                if parsed:
                    results.append(parsed)
    except Exception as exc:
        logger.warning(f"InnerTube search parse error: {exc!s:.120}")

    return results


def _parse_search_item(
    item: dict[str, Any],
    filter: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Parse a single search result item."""
    # Video (song) result
    video_renderer = item.get("videoRenderer")
    if video_renderer:
        if filter == "albums" or filter == "artists":
            return None
        return _parse_video_renderer(video_renderer)

    # Channel (artist) result
    channel_renderer = item.get("channelRenderer")
    if channel_renderer:
        if filter == "songs" or filter == "albums":
            return None
        return _parse_channel_renderer(channel_renderer)

    # Playlist result (sometimes used for albums in WEB client)
    playlist_renderer = item.get("playlistRenderer")
    if playlist_renderer and filter == "albums":
        return _parse_playlist_as_album(playlist_renderer)

    # Grid playlist renderer
    grid_playlist = item.get("gridPlaylistRenderer")
    if grid_playlist and filter == "albums":
        return _parse_grid_playlist_as_album(grid_playlist)

    return None


def _get_text(runs_or_simple: Any) -> str:
    """Extract text from InnerTube's {runs: [...]} or {simpleText: '...'} format."""
    if isinstance(runs_or_simple, dict):
        if "runs" in runs_or_simple:
            return "".join(r.get("text", "") for r in runs_or_simple["runs"])
        if "simpleText" in runs_or_simple:
            return runs_or_simple["simpleText"]
    return str(runs_or_simple) if runs_or_simple else ""


def _get_thumbnail(thumbnails_list: Any) -> str:
    """Extract the highest-res thumbnail URL."""
    if isinstance(thumbnails_list, dict):
        thumbs = thumbnails_list.get("thumbnails", [])
    elif isinstance(thumbnails_list, list):
        thumbs = thumbnails_list
    else:
        return ""
    if thumbs and isinstance(thumbs[-1], dict):
        return thumbs[-1].get("url", "")
    return ""


def _parse_duration(duration_text: str) -> int:
    """Parse duration string like 'M:SS' or 'H:MM:SS' to seconds."""
    try:
        parts = list(map(int, duration_text.split(":")))
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
        elif len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
    except (ValueError, IndexError):
        pass
    return 200


def _parse_video_renderer(renderer: dict) -> dict[str, Any]:
    """Parse a videoRenderer into ytmusicapi-compatible song dict."""
    video_id = renderer.get("videoId", "")

    title = _get_text(renderer.get("title", {}))
    if not title:
        title = _get_text(renderer.get("headline", {}))

    # Extract artist from longBylineText or ownerText
    long_byline = renderer.get("longBylineText", {})
    artist = _get_text(long_byline)
    if not artist:
        short_byline = renderer.get("shortBylineText", {})
        artist = _get_text(short_byline)
    if not artist:
        owner_text = renderer.get("ownerText", {})
        artist = _get_text(owner_text)

    # Thumbnail
    thumbnail = _get_thumbnail(renderer.get("thumbnail", {}))

    # Duration
    length_text = renderer.get("lengthText", {})
    duration_str = _get_text(length_text)
    duration = _parse_duration(duration_str) if duration_str else 200

    return {
        "videoId": video_id,
        "title": title,
        "artist": artist,
        "thumbnail": thumbnail,
        "duration": duration,
        "metadata": {"album": ""},
    }


def _parse_channel_renderer(renderer: dict) -> dict[str, Any]:
    """Parse a channelRenderer into ytmusicapi-compatible artist dict."""
    channel_id = renderer.get("channelId", "")
    title = _get_text(renderer.get("title", {}))
    thumbnail = _get_thumbnail(renderer.get("thumbnail", {}))

    return {
        "id": channel_id,
        "name": title,
        "thumbnail": thumbnail,
    }


def _parse_playlist_as_album(renderer: dict) -> dict[str, Any]:
    """Parse a playlistRenderer as an album result."""
    playlist_id = renderer.get("playlistId", "")
    title = _get_text(renderer.get("title", {}))
    # Try to get artist from the longBylineText of the first video
    artist = "Unknown Artist"
    thumbnail = _get_thumbnail(renderer.get("thumbnails", {}))

    return {
        "id": playlist_id,
        "title": title,
        "artist": artist,
        "thumbnail": thumbnail,
        "year": "",
    }


def _parse_grid_playlist_as_album(renderer: dict) -> dict[str, Any]:
    """Parse a gridPlaylistRenderer as an album result."""
    browse_id = renderer.get("navigationEndpoint", {}).get("browseEndpoint", {}).get("browseId", "")
    title = _get_text(renderer.get("title", {}))
    thumbnail = _get_thumbnail(renderer.get("thumbnail", {}))

    return {
        "id": browse_id,
        "title": title,
        "artist": "Unknown Artist",
        "thumbnail": thumbnail,
        "year": "",
    }


# -- Player response parser ------------------------------------------------

def extract_player_song(
    data: Optional[dict],
) -> Optional[dict[str, Any]]:
    """
    Extract song metadata from InnerTube player response.

    Returns a ytmusicapi-compatible track dict.
    """
    if not data:
        return None

    try:
        video_details = data.get("videoDetails", {})
        video_id = video_details.get("videoId", "")
        title = video_details.get("title", "")
        author = video_details.get("author", "")
        length_sec = int(video_details.get("lengthSeconds", 0)) or 200
        thumbnail = ""
        thumbnails = video_details.get("thumbnail", {})
        if isinstance(thumbnails, dict):
            thumbs = thumbnails.get("thumbnails", [])
            if thumbs:
                thumbnail = thumbs[-1].get("url", "")

        # Try microformat for better artist info
        microformat = data.get("microformat", {})
        player_micro = microformat.get("playerMicroformatRenderer", {})
        if not thumbnail:
            thumbnail = _get_thumbnail(player_micro.get("thumbnail", {}))

        return {
            "videoId": video_id,
            "title": title,
            "artists": [{"name": author}],
            "thumbnail": [{"url": thumbnail}],
            "length": length_sec,
            "album": None,
        }
    except Exception as exc:
        logger.warning(f"InnerTube player parse error: {exc!s:.120}")
        return None


# -- Browse response parsers (playlist, album) ------------------------------

def extract_playlist(
    data: Optional[dict],
    limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    """
    Extract playlist tracks from InnerTube browse response.

    Returns a dict with 'tracks' list matching ytmusicapi format.
    """
    if not data:
        return None

    try:
        tracks: list[dict] = []
        contents = data

        # Navigate to the playlist contents
        sidebar = contents.get("sidebar", {})
        playlist_sidebar = sidebar.get("playlistSidebarRenderer", {})
        items = playlist_sidebar.get("items", [])

        # Primary info is in the second sidebar item
        secondary_renderer = items[1].get("playlistSidebarSecondaryInfoRenderer", {}) if len(items) > 1 else {}
        video_list = secondary_renderer.get("videoList", {})
        playlist_video_list = video_list.get("playlistVideoListRenderer", {})
        video_items = playlist_video_list.get("contents", [])

        # Also try the main contents
        if not video_items:
            main_contents = contents.get("contents", {})
            two_column = main_contents.get("twoColumnBrowseResultsRenderer", {})
            tabs = two_column.get("tabs", [])
            for tab in tabs:
                tab_content = tab.get("tabRenderer", {}).get("content", {})
                section_list = tab_content.get("sectionListRenderer", {})
                for section in section_list.get("contents", []):
                    item_section = section.get("itemSectionRenderer", {})
                    for item in item_section.get("contents", []):
                        playlist_video = item.get("playlistVideoRenderer", {})
                        if playlist_video:
                            video_items.append(playlist_video)

        for item in video_items:
            video = item.get("playlistVideoRenderer", {})
            if not video:
                continue

            vid = video.get("videoId", "")
            if not vid:
                continue

            title = _get_text(video.get("title", {}))
            video_thumbnail = _get_thumbnail(video.get("thumbnail", {}))

            # Extract artists from shortBylineText
            byline = video.get("shortBylineText", {})
            artist_text = _get_text(byline)
            artists = [{"name": a.strip()} for a in artist_text.split(",")] if artist_text else [{"name": "Unknown Artist"}]

            # Duration
            length_sec = 200
            length_text = video.get("lengthSeconds", "")
            if length_text:
                try:
                    length_sec = int(length_text)
                except (ValueError, TypeError):
                    pass
            if not length_text:
                duration_text = _get_text(video.get("lengthText", {}))
                if duration_text:
                    length_sec = _parse_duration(duration_text)

            # Album name (not always available from WEB client)
            album_name = ""
            long_byline = video.get("longBylineText", {})
            long_text = _get_text(long_byline)
            # Sometimes album is in the fourth run of longBylineText
            runs = long_byline.get("runs", [])
            if len(runs) >= 4:
                album_name = runs[-1].get("text", "")

            track = {
                "videoId": vid,
                "title": title,
                "artists": artists,
                "thumbnail": [{"url": video_thumbnail}],
                "length": length_sec,
                "album": {"name": album_name} if album_name else None,
                "duration_seconds": length_sec,
            }
            tracks.append(track)

            if limit and len(tracks) >= limit:
                break

        return {"tracks": tracks} if tracks else None

    except Exception as exc:
        logger.warning(f"InnerTube playlist parse error: {exc!s:.120}")
        return None


def extract_album(data: Optional[dict]) -> Optional[dict[str, Any]]:
    """
    Extract album details from InnerTube browse response.

    Returns a dict matching ytmusicapi.get_album() format.
    """
    if not data:
        return None

    try:
        # Navigate to album header
        contents = data.get("contents", {})
        two_column = contents.get("twoColumnBrowseResultsRenderer", {})
        tabs = two_column.get("tabs", [])
        if not tabs:
            return extract_playlist(data)  # fallback: treat as playlist

        tab_content = tabs[0].get("tabRenderer", {}).get("content", {})
        section_list = tab_content.get("sectionListRenderer", {})
        sections = section_list.get("contents", [])

        album_title = ""
        album_artist = ""
        album_thumbnail = ""

        # Find the header
        for section in sections:
            header = section.get("musicDetailHeaderRenderer", {}) or section.get("musicHeaderRenderer", {})
            if header:
                album_title = _get_text(header.get("title", {}))
                subtitle_runs = header.get("subtitle", {}).get("runs", [])
                if subtitle_runs:
                    album_artist = subtitle_runs[0].get("text", "")
                album_thumbnail = _get_thumbnail(header.get("thumbnail", {}))
                break

        # Extract tracks
        tracks: list[dict] = []
        for section in sections:
            item_section = section.get("itemSectionRenderer", {})
            for item in item_section.get("contents", []):
                playlist_video = item.get("playlistVideoRenderer", {})
                if playlist_video:
                    vid = playlist_video.get("videoId", "")
                    if not vid:
                        continue
                    title = _get_text(playlist_video.get("title", {}))
                    byline = playlist_video.get("shortBylineText", {})
                    artist_text = _get_text(byline)
                    artists = [{"name": a.strip()} for a in artist_text.split(",")] if artist_text else [{"name": album_artist}]
                    video_thumbnail = _get_thumbnail(playlist_video.get("thumbnail", {}))

                    length_sec = 200
                    length_text = playlist_video.get("lengthSeconds", "")
                    if length_text:
                        try:
                            length_sec = int(length_text)
                        except (ValueError, TypeError):
                            pass
                    if not length_text:
                        duration_text = _get_text(playlist_video.get("lengthText", {}))
                        if duration_text:
                            length_sec = _parse_duration(duration_text)

                    tracks.append({
                        "videoId": vid,
                        "title": title,
                        "artists": artists,
                        "thumbnail": [{"url": video_thumbnail}],
                        "length": length_sec,
                        "album": {"name": album_title} if album_title else None,
                        "duration_seconds": length_sec,
                    })

        if not album_title and not tracks:
            # Fallback: try playlist-style parsing
            return extract_playlist(data)

        return {
            "title": album_title or "Unknown Album",
            "artists": [{"name": album_artist}] if album_artist else [{"name": "Unknown Artist"}],
            "thumbnails": [{"url": album_thumbnail}] if album_thumbnail else [],
            "tracks": tracks,
        }

    except Exception as exc:
        logger.warning(f"InnerTube album parse error: {exc!s:.120}")
        return None


# -- Next response parser (watch-playlist / related) -----------------------

def extract_watch_playlist(
    data: Optional[dict],
    limit: int = 20,
) -> Optional[dict[str, Any]]:
    """
    Extract related tracks from InnerTube next response.

    Returns a dict with 'tracks' list and optional 'lyrics' browseId,
    matching ytmusicapi.get_watch_playlist() format.
    """
    if not data:
        return None

    try:
        tracks: list[dict] = []
        lyrics_browse_id: Optional[str] = None

        # Navigate to the "up next" / related videos section
        contents = data.get("contents", {})
        two_column = contents.get("twoColumnWatchNextResults", {})
        secondary = two_column.get("secondaryResults", {})
        secondary_results = secondary.get("secondaryResultsRenderer", {})
        results_list = secondary_results.get("results", [])

        for result in results_list:
            compact_video = result.get("compactVideoRenderer", {})
            if not compact_video:
                continue

            vid = compact_video.get("videoId", "")
            if not vid:
                continue

            title = _get_text(compact_video.get("title", {}))
            byline = compact_video.get("shortBylineText", {})
            artist_text = _get_text(byline)
            artists = [{"name": a.strip()} for a in artist_text.split(",")] if artist_text else [{"name": "Unknown Artist"}]
            thumbnail = _get_thumbnail(compact_video.get("thumbnail", {}))

            length_sec = 200
            length_text = compact_video.get("lengthText", {})
            duration_str = _get_text(length_text)
            if duration_str:
                length_sec = _parse_duration(duration_str)

            tracks.append({
                "videoId": vid,
                "title": title,
                "artists": artists,
                "thumbnail": [{"url": thumbnail}],
                "length": length_sec,
                "album": None,
            })

            if len(tracks) >= limit:
                break

        result: dict[str, Any] = {"tracks": tracks}
        return result if tracks else None

    except Exception as exc:
        logger.warning(f"InnerTube watch-playlist parse error: {exc!s:.120}")
        return None
