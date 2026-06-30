"""
Search proxy route — bridges client-side search requests to Invidious.

The frontend calls this endpoint instead of talking to Invidious directly,
avoiding CORS issues with public Invidious instances. The backend makes a
server-to-server request to Invidious, which has no CORS restrictions.

Also includes a fallback to ytmusicapi when Invidious is unreachable.
"""

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Query

from app.services.cache import TTLCache
from app.services.ytmusic import search_ytmusic_safe

logger = logging.getLogger("strumm-search-proxy")
router = APIRouter(prefix="/search", tags=["search"])

# Default Invidious instance — configurable via env var
INVIDIOUS_INSTANCE = "https://inv.nadeko.net"
SEARCH_CACHE_TTL = 120  # seconds

# Dedicated in-memory cache for search proxy results
_search_cache = TTLCache(max_size=100)

# User-agent for Invidious requests (avoids bot blocking)
_INVIDIOUS_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


def _video_to_song(v: dict) -> dict:
    """Map an Invidious video result to the Song shape used throughout the app."""
    thumbs = v.get("videoThumbnails") or []
    thumb_url = (
        next((t["url"] for t in thumbs if t.get("quality") == "medium"), None)
        or next((t["url"] for t in thumbs if t.get("quality") == "hq720"), None)
        or (thumbs[0]["url"] if thumbs else None)
        or f"https://img.youtube.com/vi/{v.get('videoId', '')}/hqdefault.jpg"
    )
    return {
        "videoId": v.get("videoId", ""),
        "title": v.get("title", "Untitled"),
        "artist": v.get("author", "Unknown Artist"),
        "thumbnail": thumb_url,
        "duration": v.get("lengthSeconds", 200),
    }


def _playlist_to_album(p: dict) -> dict:
    """Map an Invidious playlist result to the Album shape."""
    return {
        "id": p.get("playlistId", ""),
        "title": p.get("title", "Untitled"),
        "artist": p.get("author", "Unknown Artist"),
        "thumbnail": p.get("playlistThumbnail", ""),
        "year": "",
    }


def _channel_to_artist(c: dict) -> dict:
    """Map an Invidious channel result to the Artist shape."""
    thumbs = c.get("authorThumbnails") or []
    return {
        "id": c.get("authorId", ""),
        "name": c.get("author", "Unknown"),
        "thumbnail": thumbs[-1]["url"] if thumbs else "",
    }


async def _fetch_invidious_type(
    client: httpx.AsyncClient,
    t: str,
    q: str,
    page: int,
) -> list[dict]:
    """Fetch a single type from Invidious and return the parsed items."""
    try:
        resp = await client.get(
            f"{INVIDIOUS_INSTANCE}/api/v1/search",
            params={"q": q, "page": page, "type": t},
            headers={"User-Agent": _INVIDIOUS_UA},
        )
        if resp.status_code != 200:
            logger.warning(
                "Invidious returned HTTP %d for type=%s query=%r",
                resp.status_code, t, q,
            )
            return []
        data = resp.json()
        if not isinstance(data, list):
            logger.warning(
                "Invidious returned non-list response for type=%s: %s",
                t, type(data).__name__,
            )
            return []
        return data
    except httpx.TimeoutException:
        logger.warning("Invidious timed out for type=%s query=%r", t, q)
    except httpx.RequestError as exc:
        logger.warning("Invidious request failed for type=%s query=%r: %s", t, q, exc)
    except Exception as exc:
        logger.error("Unexpected error fetching Invidious type=%s query=%r: %s", t, q, exc)
    return []


@router.get("/proxy")
async def search_proxy(
    q: str = Query(..., min_length=1, max_length=200),
    type: str = Query("all", pattern="^(video|playlist|channel|all)$"),
    page: int = Query(1, ge=1, le=10),
):
    """
    Proxy search requests to a public Invidious instance server-side.

    Returns categorised results (songs, albums, artists) just like the
    client-side searchInvidious function did, so the frontend can swap
    seamlessly.
    """
    cache_key_str = f"search_proxy:{q}:{type}:{page}"
    cached = _search_cache.get(cache_key_str)
    if cached is not None:
        return cached

    songs: list[dict[str, Any]] = []
    albums: list[dict[str, Any]] = []
    artists: list[dict[str, Any]] = []

    if type == "all":
        types_to_fetch = ["video", "playlist", "channel"]
    else:
        types_to_fetch = [type]

    # Fetch all requested types in parallel for lower latency
    async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
        tasks = [
            _fetch_invidious_type(client, t, q, page)
            for t in types_to_fetch
        ]
        results = await asyncio.gather(*tasks)

    # Parse results
    for t, data in zip(types_to_fetch, results):
        for item in data:
            if not isinstance(item, dict):
                continue
            if t == "video" and (item.get("type") == "video" or item.get("videoId")):
                songs.append(_video_to_song(item))
            elif t == "playlist" and (item.get("type") == "playlist" or item.get("playlistId")):
                albums.append(_playlist_to_album(item))
            elif t == "channel" and (item.get("type") == "channel" or item.get("authorId")):
                artists.append(_channel_to_artist(item))

    # Fallback to ytmusicapi if Invidious returned nothing
    if not songs and not albums and not artists:
        logger.info("Invidious returned empty results, falling back to ytmusicapi")
        try:
            yt_results = await asyncio.to_thread(
                lambda: search_ytmusic_safe(q, filter="songs")
            )
            for item in yt_results or []:
                song = {
                    "videoId": item.get("videoId", ""),
                    "title": item.get("title", "Untitled"),
                    "artist": item.get("artists", [{}])[0].get("name", "Unknown Artist")
                    if item.get("artists") else "Unknown Artist",
                    "thumbnail": (
                        item.get("thumbnails", [{}])[-1].get("url", "")
                        if item.get("thumbnails") else ""
                    ),
                    "duration": item.get("duration", 200),
                }
                songs.append(song)
        except Exception as exc:
            logger.error("ytmusicapi fallback search failed: %s", exc)

    result = {
        "success": True,
        "data": {
            "songs": songs,
            "albums": albums,
            "artists": artists,
        },
    }

    _search_cache.set(cache_key_str, result, ttl=SEARCH_CACHE_TTL)
    return result


@router.get("/proxy/video/{video_id}")
async def video_details_proxy(video_id: str):
    """Proxy video details request to Invidious."""
    cache_key_str = f"search_proxy_video:{video_id}"
    cached = _search_cache.get(cache_key_str)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
        try:
            resp = await client.get(
                f"{INVIDIOUS_INSTANCE}/api/v1/videos/{video_id}",
                headers={"User-Agent": _INVIDIOUS_UA},
            )
            if resp.status_code == 200:
                data = resp.json()
                song = _video_to_song(data)
                result = {"success": True, "data": song}
                _search_cache.set(cache_key_str, result, ttl=SEARCH_CACHE_TTL)
                return result
        except Exception as exc:
            logger.warning("Invidious video details failed for %s: %s", video_id, exc)

    return {"success": False, "data": None, "error": "Failed to fetch video details."}


@router.get("/proxy/playlist/{playlist_id}")
async def playlist_items_proxy(playlist_id: str):
    """Proxy playlist items request to Invidious."""
    cache_key_str = f"search_proxy_playlist:{playlist_id}"
    cached = _search_cache.get(cache_key_str)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
        try:
            resp = await client.get(
                f"{INVIDIOUS_INSTANCE}/api/v1/playlists/{playlist_id}",
                headers={"User-Agent": _INVIDIOUS_UA},
            )
            if resp.status_code == 200:
                data = resp.json()
                videos = data.get("videos") or []
                songs = [_video_to_song(v) for v in videos if isinstance(v, dict)]
                result = {"success": True, "data": songs}
                _search_cache.set(cache_key_str, result, ttl=SEARCH_CACHE_TTL)
                return result
        except Exception as exc:
            logger.warning("Invidious playlist items failed for %s: %s", playlist_id, exc)

    return {"success": False, "data": [], "error": "Failed to fetch playlist items."}
