"""
YouTube search fallback providers for the Python API backend.

When YouTube Music (ytmusicapi) is unreachable from this host — e.g. because
the hosting provider's egress IP is blocked by YouTube's CDN — playlist import
matching can still resolve tracks through a secondary provider. This module
implements three such providers, all returning results in the *same raw shape*
the playlist importer already understands (``_rank_candidates`` /
``_build_song_item`` in ``app/routes/playlist.py``):

    videoId, title, artists: [{"name": ...}], duration ("m:ss"), 
    duration_seconds, thumbnails: [{"url": ...}]

Provider order (first provider that returns results wins):

    1. YouTube Data API v3  — requires ``YOUTUBE_API_KEY`` (Google Cloud key
       with the "YouTube Data API v3" service enabled). Free tier: 10k
       units/day; each search costs 1 unit. Returns general YouTube videos,
       not curated YouTube Music tracks, so matching quality is lower than
       ytmusicapi but far better than failing the whole import.
    2. Piped instances     — keyless public Piped instances (no API key, no
       per-app quota). Piped is a privacy-focused YouTube proxy that performs
       the YouTube request itself, so it is reachable even when this host's
       egress IP is blocked by Google's CDN. Mirrors the web app's own Piped
       ("invidiousProvider") search provider.
    3. yt-dlp              — installed as ``yt-dlp``. Uses yt-dlp's YouTube
       search extractor for search/metadata only (no audio downloads).

All providers are optional and degrade gracefully when:
    * the API key is unset / returns 403 (quota or auth),
    * every Piped instance is unreachable / returns error, or
    * yt-dlp is not installed / raises at runtime.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import requests

logger = logging.getLogger("strumm-ytfallback")

# Google Cloud API key with "YouTube Data API v3" enabled (same key the
# downstream web app uses for its own search provider).
YOUTUBE_API_KEY = (os.getenv("YOUTUBE_API_KEY") or "").strip()

YT_API_SEARCH = "https://www.googleapis.com/youtube/v3/search"
YT_DATA_TIMEOUT = (3.0, 8.0)

# Public Piped instance API roots, tried in order. Piped is keyless — no API
# key, no per-app quota — and the instance performs the YouTube request, so
# these stay reachable from cloud IPs that Google's CDN blocks directly.
#
# The list is CONFIGURABLE at runtime via the ``PIPED_INSTANCES`` env var
# (comma-separated URLs). When unset it defaults to the maintained list below,
# which mirrors the web app's former Piped search provider seed (2026-09):
# `api.piped.private.coffee` is verified live. HTTP failures rotate to the next
# instance automatically, so an instance that is added later (or removed) can
# be flipped via env without a code deploy.
PIPED_DEFAULT_INSTANCES = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.r4fo.com",
]


def _load_piped_instances() -> list[str]:
    """Read the configured Piped instance roots, validating each entry.

    Values may be comma-separated in the ``PIPED_INSTANCES`` env var. Entries
    are stripped of trailing slashes; blank entries are dropped. On any parsing
    problem the default list is used so a broken env value can never leave the
    provider with zero instances.
    """
    raw = (os.getenv("PIPED_INSTANCES") or "").strip()
    if not raw:
        return list(PIPED_DEFAULT_INSTANCES)
    entries = [
        p.strip().rstrip("/") for p in raw.split(",") if p.strip() and p.strip().rstrip("/")
    ]
    if not entries or not all(e.startswith("http") for e in entries):
        logger.warning(
            "PIPED_INSTANCES env var is empty or invalid; using default instances."
        )
        return list(PIPED_DEFAULT_INSTANCES)
    return entries


PIPED_INSTANCES = _load_piped_instances()

PIPED_TIMEOUT = (3.0, 8.0)

# UTC offset guard: Data API /search returns no duration. Flip to True to also
# pass a duration if you add a /videos lookup. (Defaults off — cheap.)
FETCH_DURATION = False


# ---------------------------------------------------------------------------
# Shape helpers — normalize provider responses to the importer's raw item shape
# ---------------------------------------------------------------------------


def _to_seconds(mmss: Optional[str]) -> int:
    """Convert a "m:ss" / "h:mm:ss" duration string to seconds."""
    if not mmss:
        return 0
    parts = [p for p in mmss.split(":") if p.isdigit()]
    if not parts:
        return 0
    total = 0
    for p in parts:
        total = total * 60 + int(p)
    return total


def _seconds_to_mmss(seconds: int) -> str:
    """Convert seconds to a "m:ss" / "h:mm:ss" string (importer-friendly)."""
    if seconds <= 0:
        return ""
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


# ---------------------------------------------------------------------------
# YouTube Data API v3 provider
# ---------------------------------------------------------------------------


def _ytdata_enabled() -> bool:
    return bool(YOUTUBE_API_KEY)


def ytdata_search(query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """
    Search YouTube via the Data API v3 ``/search`` endpoint.

    Returns a list of raw items shaped for the importer. Empty on any failure
    (no key, quota 403, network error) so callers fall through to the next
    provider or surface the original YTMusic status.
    """
    if not _ytdata_enabled():
        return []

    params = {
        "part": "snippet",
        "type": "video",
        "q": query,
        "maxResults": str(limit),
        "key": YOUTUBE_API_KEY,
        "safeSearch": "none",
    }
    try:
        resp = requests.get(
            YT_API_SEARCH, params=params, timeout=YT_DATA_TIMEOUT
        )
        if resp.status_code == 403:
            logger.warning(
                f"YouTube Data API auth/quota error (403) for q={query!r} "
                f"— {resp.text[:160]}"
            )
            return []
        if resp.status_code != 200:
            logger.warning(
                f"YouTube Data API HTTP {resp.status_code} for q={query!r} "
                f"— {resp.text[:160]}"
            )
            return []
        payload = resp.json()
    except Exception as exc:
        logger.warning(
            f"YouTube Data API request failed for q={query!r}: "
            f"{type(exc).__name__}: {exc!s:.120}"
        )
        return []

    items = payload.get("items") or []
    results: list[dict[str, Any]] = []
    for item in items:
        snippet = item.get("snippet") or {}
        vid = (item.get("id") or {}).get("videoId")
        if not vid:
            continue
        title = snippet.get("title") or ""
        channel = snippet.get("channelTitle") or ""
        thumbs = snippet.get("thumbnails") or {}
        thumb_url = (
            thumbs.get("medium", {}).get("url")
            or thumbs.get("high", {}).get("url")
            or thumbs.get("default", {}).get("url")
            or ""
        )
        results.append({
            "videoId": vid,
            "title": title,
            "artists": [{"name": channel}] if channel else [],
            "artist": channel,
            "duration": "",
            "duration_seconds": 0,
            "thumbnails": [{"url": thumb_url}] if thumb_url else [],
        })
    return results


# ---------------------------------------------------------------------------
# yt-dlp provider (search / metadata only)
# ---------------------------------------------------------------------------


def _ytdlp_available() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except Exception:
        return False


def ytdlp_search(query: str, *, limit: int = 8) -> list[dict[str, Any]]:
    """
    Search YouTube using yt-dlp's search extractor (metadata only, no audio).

    ``yt-dlp`` must be installed. Returns raw importer-shaped items. Empty on
    any failure so callers fall through gracefully.
    """
    if not _ytdlp_available():
        return []

    try:
        import yt_dlp

        search_query = f"ytsearch{limit}:{query}"
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            entries = ydl.extract_info(search_query, download=False) or {}
            entries = entries.get("entries") or []
    except Exception as exc:
        logger.warning(
            f"yt-dlp search failed for q={query!r}: {type(exc).__name__}: {exc!s:.120}"
        )
        return []

    results: list[dict[str, Any]] = []
    for e in entries:
        if not e:
            continue
        vid = (e.get("id") or "").strip()
        if not vid or not _looks_like_video_id(vid):
            continue
        title = (e.get("title") or "")
        channel = (e.get("uploader") or e.get("channel") or "")
        duration_seconds = int(e.get("duration") or 0)
        thumbs = e.get("thumbnails") or []
        thumb_url = ""
        if thumbs:
            # Prefer the largest thumbnail URL available.
            best = max(
                (t for t in thumbs if t.get("url")),
                key=lambda t: int(t.get("width") or 0) + int(t.get("height") or 0),
                default=None,
            )
            thumb_url = best["url"] if best else thumbs[-1].get("url", "")
        results.append({
            "videoId": vid,
            "title": title,
            "artists": [{"name": channel}] if channel else [],
            "artist": channel,
            "duration": _seconds_to_mmss(duration_seconds),
            "duration_seconds": duration_seconds,
            "thumbnails": [{"url": thumb_url}] if thumb_url else [],
        })
    return results


def _looks_like_video_id(vid: str) -> bool:
    """YouTube 11-char video IDs are alphanumeric plus ``_`` / ``-``."""
    return len(vid) >= 6 and all(c.isalnum() or c in "_-" for c in vid)


# ---------------------------------------------------------------------------
# Piped provider (keyless, no quota)
# ---------------------------------------------------------------------------


def _extract_piped_video_id(url: str) -> Optional[str]:
    """Pull a validated video id out of a Piped ``/watch?v=...`` url."""
    if "?v=" not in url:
        return None
    vid = url.split("?v=", 1)[1].split("&", 1)[0].strip()
    return vid if _looks_like_video_id(vid) else None


def piped_search(query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """
    Search YouTube via public Piped instances (keyless, no quota).

    Instances are tried in order and the first one to return results wins.
    Returns raw importer-shaped items; empty when every instance is
    unreachable or returns nothing, so callers fall through gracefully.
    """
    for base in PIPED_INSTANCES:
        try:
            resp = requests.get(
                f"{base}/search",
                params={"q": query, "filter": "videos"},
                timeout=PIPED_TIMEOUT,
            )
            if resp.status_code != 200:
                logger.warning(
                    f"Piped {base} HTTP {resp.status_code} for q={query!r}"
                )
                continue
            payload = resp.json()
        except Exception as exc:
            logger.warning(
                f"Piped {base} request failed for q={query!r}: "
                f"{type(exc).__name__}: {exc!s:.120}"
            )
            continue

        items = payload.get("items") or []
        results: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            vid = _extract_piped_video_id(item.get("url") or "")
            if not vid:
                continue
            title = item.get("title") or ""
            artist = item.get("uploaderName") or ""
            duration_seconds = int(item.get("duration") or 0)
            thumb_url = item.get("thumbnail") or ""
            results.append({
                "videoId": vid,
                "title": title,
                "artists": [{"name": artist}] if artist else [],
                "artist": artist,
                "duration": _seconds_to_mmss(duration_seconds),
                "duration_seconds": duration_seconds,
                "thumbnails": [{"url": thumb_url}] if thumb_url else [],
            })

        if results:
            return results[:limit]

    return []


# ---------------------------------------------------------------------------
# Public fallback chain
# ---------------------------------------------------------------------------


def search_fallback(query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """
    Try the secondary providers in order and return the first non-empty result.

    Order: YouTube Data API v3, then public Piped instances, then yt-dlp.
    All are optional and return empty on failure, so a provider that isn't
    configured (or can't be reached) is simply skipped.
    """
    results = ytdata_search(query, limit=limit)
    if results:
        return results

    results = piped_search(query, limit=limit)
    if results:
        return results

    results = ytdlp_search(query, limit=limit)
    if results:
        return results

    return []
