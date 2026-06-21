import hashlib
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from app.services.security import sanitize_multiline_text, sanitize_positive_int, sanitize_text


PODCAST_INDEX_BASE_URL = "https://api.podcastindex.org/api/1.0"
PODCAST_INDEX_USER_AGENT = os.getenv("PODCAST_INDEX_USER_AGENT", "Strumm-Ecosystem/1.0.0")


class PodcastIndexNotConfigured(RuntimeError):
    pass


def _credentials() -> tuple[str, str]:
    api_key = os.getenv("PODCAST_INDEX_API_KEY")
    api_secret = os.getenv("PODCAST_INDEX_API_SECRET")
    if not api_key or not api_secret:
        raise PodcastIndexNotConfigured("PodcastIndex credentials are not configured.")
    return api_key, api_secret


def _headers() -> Dict[str, str]:
    api_key, api_secret = _credentials()
    epoch_time = str(int(time.time()))
    auth_hash = hashlib.sha1(f"{api_key}{api_secret}{epoch_time}".encode("utf-8")).hexdigest()
    return {
        "User-Agent": PODCAST_INDEX_USER_AGENT,
        "X-Auth-Key": api_key,
        "X-Auth-Date": epoch_time,
        "Authorization": auth_hash,
    }


async def _get(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{PODCAST_INDEX_BASE_URL}{path}",
            params=params,
            headers=_headers(),
            timeout=8.0,
        )
        response.raise_for_status()
        return response.json()


def _categories(value: Any) -> List[str]:
    if isinstance(value, dict):
        return [sanitize_text(str(v), max_length=80) for v in value.values() if v]
    if isinstance(value, list):
        return [sanitize_text(str(v), max_length=80) for v in value if v]
    return []


def map_feed(feed: Dict[str, Any]) -> Dict[str, Any]:
    image = feed.get("image") or feed.get("artwork") or ""
    return {
        "id": str(feed.get("id", "")),
        "title": sanitize_text(feed.get("title") or "Untitled Show", max_length=200),
        "author": sanitize_text(feed.get("author") or feed.get("ownerName") or "Unknown Author", max_length=160),
        "description": sanitize_multiline_text(
            feed.get("description") or feed.get("summary") or "",
            max_length=3000,
        ),
        "image": sanitize_text(image, max_length=1000),
        "rss": sanitize_text(feed.get("url") or feed.get("originalUrl") or "", max_length=1000),
        "categories": _categories(feed.get("categories"))[:8],
    }


def _published_at(epoch_value: Any) -> Optional[str]:
    try:
        epoch = int(epoch_value)
        if epoch <= 0:
            return None
        return datetime.utcfromtimestamp(epoch).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def map_episode(episode: Dict[str, Any], show_id: str) -> Optional[Dict[str, Any]]:
    audio_url = episode.get("enclosureUrl") or episode.get("audioUrl") or ""
    if not audio_url:
        return None

    return {
        "id": str(episode.get("id", "")),
        "showId": show_id,
        "title": sanitize_text(episode.get("title") or "Untitled Episode", max_length=240),
        "audioUrl": sanitize_text(audio_url, max_length=1200),
        "duration": sanitize_positive_int(episode.get("duration") or 1800, minimum=0, maximum=86400),
        "description": sanitize_multiline_text(
            episode.get("description") or episode.get("summary") or "",
            max_length=5000,
        ),
        "publishedAt": _published_at(episode.get("datePublished")),
    }


async def search_podcasts(term: str, *, max_results: int = 20) -> List[Dict[str, Any]]:
    q = sanitize_text(term, max_length=120)
    if not q:
        return []
    data = await _get("/search/byterm", {"q": q, "max": max(1, min(max_results, 40)), "clean": 1})
    return [map_feed(feed) for feed in data.get("feeds", []) if feed.get("id")]


async def trending_podcasts(*, max_results: int = 24) -> List[Dict[str, Any]]:
    data = await _get("/podcasts/trending", {"max": max(1, min(max_results, 40)), "clean": 1})
    return [map_feed(feed) for feed in data.get("feeds", []) if feed.get("id")]


async def recent_podcasts(*, max_results: int = 24) -> List[Dict[str, Any]]:
    data = await _get("/recent/feeds", {"max": max(1, min(max_results, 40)), "clean": 1})
    return [map_feed(feed) for feed in data.get("feeds", []) if feed.get("id")]


async def get_podcast(feed_id: str) -> Optional[Dict[str, Any]]:
    sanitized_id = sanitize_positive_int(int(feed_id), minimum=1, maximum=10_000_000_000)
    data = await _get("/podcasts/byfeedid", {"id": sanitized_id})
    feed = data.get("feed")
    return map_feed(feed) if feed else None


async def get_episodes(feed_id: str, *, max_results: int = 30) -> List[Dict[str, Any]]:
    sanitized_id = sanitize_positive_int(int(feed_id), minimum=1, maximum=10_000_000_000)
    data = await _get(
        "/episodes/byfeedid",
        {"id": sanitized_id, "max": max(1, min(max_results, 100)), "fulltext": 1},
    )
    episodes = []
    for episode in data.get("items", []):
        mapped = map_episode(episode, str(sanitized_id))
        if mapped:
            episodes.append(mapped)
    return episodes
