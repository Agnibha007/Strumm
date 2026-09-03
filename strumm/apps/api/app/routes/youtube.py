"""YouTube Music / Piped proxy endpoints.

Moves all YouTube playlist/stream/search/related metadata resolution BEHIND the
FastAPI backend so the browser never calls public Piped instances directly
(which fail with CORS / 403 / 525 from arbitrary origins).

The browser talks to these endpoints via the same-origin `/proxy` rewrite, and
each response is shaped to match what the legacy browser-side Piped client
(``InvidiousProvider.ts`` / ``BrowserYouTubeMusicResolver.ts``) already parsed.
That keeps the frontend's existing mappers/pickers/pagination intact — only the
transport target changes, and no large media bytes are proxied (these are
metadata resolution endpoints only).

Provider chain (first provider that returns usable data wins):

    ytmusicapi (primary) -> Piped instances (keyless fallback) -> yt-dlp

The Piped instance set is read from ``PIPED_INSTANCES`` (see ``ytfallback.py``;
env-configurable, defaults to the maintained list). All metadata is cached by
the existing ytmusic / cache layers.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, Query

from app.services.ytfallback import PIPED_INSTANCES, PIPED_TIMEOUT
from app.services.http_client import get_http_client
from app.services.security import sanitize_youtube_id

logger = logging.getLogger("strumm-youtube-proxy")
router = APIRouter(prefix="/yt", tags=["youtube"])


# ---------------------------------------------------------------------------
# Normalization helpers (provider responses -> Piped-compatible shapes)
# ---------------------------------------------------------------------------


def _piped_pick_thumb(thumbnails: Any, fallback_vid: Optional[str] = "") -> str:
    """Pick the largest thumbnail URL (mirrors yt-dlp/Piped conventions)."""
    url = ""
    if isinstance(thumbnails, list) and thumbnails:
        best = None
        for t in thumbnails:
            if not isinstance(t, dict):
                continue
            u = str(t.get("url") or "")
            if not u:
                continue
            size = int(t.get("width") or 0) * int(t.get("height") or 0)
            if best is None or size > best[0]:
                best = (size, u)
        url = best[1] if best else ""
    if not url and fallback_vid:
        url = f"https://img.youtube.com/vi/{fallback_vid}/hqdefault.jpg"
    return url


def _piped_artist(artists: Any) -> str:
    """Join a list of {'name': ...} (ytmusic) into a single uploader string."""
    if isinstance(artists, list):
        names = [
            str(a.get("name") or "").strip()
            for a in artists
            if isinstance(a, dict) and a.get("name")
        ]
        if names:
            return ", ".join(names)
    return "Unknown Artist"


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


async def _search_server(query: str, type_: str) -> dict:
    """Resolve a search server-side into a Piped ``items`` payload.

    Primary: ytmusicapi search. Fallback: ytfallback chain (YouTube Data API,
    then Piped, then yt-dlp). Anything unreachable/timeouts/5xx degrades to an
    empty search rather than erroring — the frontend treats an empty result as
    "no results" and moves on.
    """
    filter_map = {
        "song": "songs",
        "playlist": "playlists",
        "channel": "artists",
        "all": "",
        "videos": "songs",
    }
    items: list[dict] = []

    # 1. ytmusicapi (messages = playlists, filters = songs), index top hits.
    try:
        from app.services.ytmusic import search_ytmusic_safe

        if type_ in ("song", "videos", "all"):
            songs = await asyncio.to_thread(
                lambda: search_ytmusic_safe(query, filter="songs")
            )
            for s in songs or []:
                if not isinstance(s, dict):
                    continue
                vid = str(s.get("videoId") or "").strip()
                title = str(s.get("title") or "").strip()
                if not vid or not title:
                    continue
                items.append({
                    "url": f"/watch?v={vid}",
                    "type": "stream",
                    "title": title,
                    "thumbnail": _piped_pick_thumb(s.get("thumbnails"), vid),
                    "uploaderName": _piped_artist(s.get("artists")),
                    "duration": int(s.get("duration") or 0),
                })

        if type_ in ("playlist", "all"):
            playlists = await asyncio.to_thread(
                lambda: search_ytmusic_safe(query, filter="playlists")
            )
            for p in playlists or []:
                if not isinstance(p, dict):
                    continue
                pid = str(p.get("browseId") or p.get("playlistId") or "").strip()
                title = str(p.get("title") or "").strip()
                if not pid or not title:
                    continue
                # Piped playlists key off the list=? value, not browseId.
                if pid.startswith("VL"):
                    pid = pid[2:]
                items.append({
                    "url": f"https://www.youtube.com/playlist?list={pid}",
                    "type": "playlist",
                    "name": title,
                    "thumbnail": _piped_pick_thumb(p.get("thumbnails")),
                    "uploaderName": _piped_artist(p.get("artists")),
                    "videos": int(p.get("videoCount") or 0),
                })

        if type_ in ("channel", "all"):
            artists = await asyncio.to_thread(
                lambda: search_ytmusic_safe(query, filter="artists")
            )
            for a in artists or []:
                if not isinstance(a, dict):
                    continue
                cid = str(a.get("browseId") or "").strip()
                name = str(a.get("artist") or "").strip()
                if not cid or not name:
                    continue
                items.append({
                    "url": f"/channel/{cid}",
                    "type": "channel",
                    "name": name,
                    "thumbnail": _piped_pick_thumb(a.get("thumbnails")),
                    "subscribers": int(a.get("subscribers") or 0),
                })
    except Exception as exc:  # noqa: BLE001 — fall back below
        logger.warning(f"ytmusic search failed for q={query!r}: {exc!s:.120}")

    if items:
        return {"items": items, "nextpage": ""}

    # 2. Secondary chain (ytfallback): Data API -> Piped -> yt-dlp.
    try:
        from app.services.ytfallback import search_fallback

        fallback = await asyncio.to_thread(lambda: search_fallback(query, limit=10))
        for r in fallback or []:
            vid = str(r.get("videoId") or "").strip()
            title = str(r.get("title") or "").strip()
            if not vid or not title:
                continue
            items.append({
                "url": f"/watch?v={vid}",
                "type": "stream",
                "title": title,
                "thumbnail": _piped_pick_thumb(r.get("thumbnails"), vid),
                "uploaderName": str(r.get("artist") or "Unknown Artist"),
                "duration": int(r.get("duration_seconds") or 0),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"ytfallback search failed for q={query!r}: {exc!s:.120}")

    return {"items": items, "nextpage": ""}


@router.get("/search")
async def proxy_search(
    q: str = Query(..., max_length=500, description="Search query"),
    type: str = Query("all", description="song|playlist|channel|all"),
):
    """Search YouTube Music (Piped-compatible ``items`` payload)."""
    type_ = type if type in ("song", "playlist", "channel", "all", "videos") else "all"
    payload = await _search_server(q, type_)
    return {"success": True, "data": payload}


# ---------------------------------------------------------------------------
# Playlist items
# ---------------------------------------------------------------------------


@router.get("/playlist/{playlist_id}")
async def proxy_playlist(playlist_id: str):
    """Return playlist tracks in Piped's ``relatedStreams`` shape.

    Primary: ytmusicapi ``get_playlist`` (full curated metadata). Fallback:
    server-side Piped ``/playlists/{id}``. Emits a single page with
    ``relatedStreams`` (map to the frontend's track mapper) and no ``nextpage``.
    """
    pid = playlist_id.strip()
    if not pid:
        return {"success": True, "data": {"name": "", "relatedStreams": [], "videos": 0, "nextpage": ""}}

    # 1. ytmusicapi full playlist fetch.
    related: list[dict] = []
    try:
        from app.services.ytmusic import call_ytmusic_safe

        playlist = await asyncio.to_thread(
            lambda: call_ytmusic_safe("get_playlist", pid, limit=None)
        )
        if playlist and isinstance(playlist, dict):
            name = str(playlist.get("title") or "Playlist")
            for t in playlist.get("tracks") or []:
                if not isinstance(t, dict):
                    continue
                vid = str(t.get("videoId") or "").strip()
                title = str(t.get("title") or "").strip()
                if not vid or not title:
                    continue
                related.append({
                    "url": f"/watch?v={vid}",
                    "type": "stream",
                    "title": title,
                    "thumbnail": _piped_pick_thumb(t.get("thumbnails"), vid),
                    "uploaderName": _piped_artist(t.get("artists")),
                    "duration": int(t.get("duration_seconds") or 0),
                })
            if related:
                return {
                    "success": True,
                    "data": {"name": name, "relatedStreams": related, "videos": len(related), "nextpage": ""},
                }
    except Exception as exc:  # noqa: BLE001 — fall back to Piped
        logger.warning(f"ytmusic get_playlist failed for {pid}: {exc!s:.120}")

    # 2. Server-side Piped fallback (walk pages like the old browser client).
    try:
        client = get_http_client()
        base = _pick_piped_base()
        resp = await client.get(f"{base}/playlists/{pid}", timeout=PIPED_TIMEOUT)
        if resp.status_code == 200:
            payload = resp.json()
            related = []
            for v in payload.get("relatedStreams") or []:
                if not isinstance(v, dict):
                    continue
                vid = str(_extract_video_id(v.get("url") or "") or "").strip()
                if not vid:
                    continue
                related.append({
                    "url": f"/watch?v={vid}",
                    "type": "stream",
                    "title": str(v.get("title") or "").strip() or "Untitled",
                    "thumbnail": str(v.get("thumbnail") or ""),
                    "uploaderName": str(v.get("uploaderName") or "Unknown Artist"),
                    "duration": int(v.get("duration") or 0),
                })
            return {
                "success": True,
                "data": {
                    "name": str(payload.get("name") or "Playlist"),
                    "relatedStreams": related,
                    "videos": len(related),
                    "nextpage": "",
                },
            }
        logger.warning(f"Piped playlist {pid} HTTP {resp.status_code}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"Piped playlist {pid} failed: {exc!s:.120}")

    return {"success": True, "data": {"name": "Playlist", "relatedStreams": [], "videos": 0, "nextpage": ""}}


# ---------------------------------------------------------------------------
# Streams metadata (direct audio + related)
# ---------------------------------------------------------------------------


def _extract_video_id(url: str) -> Optional[str]:
    if "?v=" in url:
        return url.split("?v=", 1)[1].split("&", 1)[0]
    return None


def _pick_piped_base() -> str:
    """Return the first configured Piped instance (server-side fallback)."""
    return PIPED_INSTANCES[0] if PIPED_INSTANCES else "https://api.piped.private.coffee"


# Overall budget for /yt/streams. The browser's ``proxyGet`` aborts at 12s, so
# this endpoint MUST resolve well under that even on a cold cache. The provider
# lookups run concurrently (not stacked) inside this deadline; on expiry we
# return whatever resolved so the audio/related pickers still get usable data
# instead of the browser timing out to a null.
STREAMS_BUDGET = 8.0


async def _resolve_watch_related(vid: str) -> list[dict]:
    """Related / radio tracks from the YTMusic watch playlist (primary)."""
    related: list[dict] = []
    try:
        from app.services.ytmusic import call_ytmusic_safe

        watch = await asyncio.to_thread(
            lambda: call_ytmusic_safe("get_watch_playlist", videoId=vid, limit=15)
        )
        for t in (watch or {}).get("tracks") or []:
            if not isinstance(t, dict):
                continue
            rvid = str(t.get("videoId") or "").strip()
            title = str(t.get("title") or "").strip()
            if not rvid or not title:
                continue
            related.append({
                "url": f"/watch?v={rvid}",
                "type": "stream",
                "title": title,
                "thumbnail": _piped_pick_thumb(t.get("thumbnail") or t.get("thumbnails"), rvid),
                "uploaderName": _piped_artist(t.get("artists")),
                "duration": int(t.get("length") or 0),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"ytmusic watch playlist failed for {vid}: {exc!s:.120}")
    return related


async def _resolve_piped_streams(vid: str) -> tuple[list[dict], list[dict], dict]:
    """One-shot Piped ``/streams/{vid}`` fallback: audio, video, metadata."""
    audio: list[dict] = []
    video: list[dict] = []
    meta: dict[str, Any] = {}
    try:
        client = get_http_client()
        base = _pick_piped_base()
        resp = await client.get(f"{base}/streams/{vid}", timeout=PIPED_TIMEOUT)
        if resp.status_code != 200:
            logger.warning(f"Piped streams {vid} HTTP {resp.status_code}")
            return audio, video, meta
        p = resp.json()
        if not isinstance(p, dict):
            return audio, video, meta
        meta = p
        for s in p.get("audioStreams") or []:
            if s and isinstance(s, dict) and s.get("url"):
                audio.append({
                    "url": s["url"],
                    "mimeType": str(s.get("mimeType") or "audio/mp4"),
                    "bitrate": int(s.get("bitrate") or 0),
                })
        for s in p.get("videoStreams") or []:
            if s and isinstance(s, dict) and s.get("url"):
                video.append({
                    "url": s["url"],
                    "mimeType": str(s.get("mimeType") or "video/mp4"),
                    "bitrate": int(s.get("bitrate") or 0),
                    "videoOnly": bool(s.get("videoOnly")),
                })
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"Piped streams {vid} failed: {exc!s:.120}")
    return audio, video, meta


def _piped_related_items(payload: dict) -> list[dict]:
    """Map a Piped ``/streams`` payload's ``relatedStreams`` to our shape."""
    out: list[dict] = []
    for r in payload.get("relatedStreams") or []:
        if not isinstance(r, dict):
            continue
        rvid = str(_extract_video_id(r.get("url") or "") or "").strip()
        if not rvid:
            continue
        out.append({
            "url": f"/watch?v={rvid}",
            "type": "stream",
            "title": str(r.get("title") or "Untitled"),
            "thumbnail": str(r.get("thumbnail") or ""),
            "uploaderName": str(r.get("uploaderName") or "Unknown Artist"),
            "duration": int(r.get("duration") or 0),
        })
    return out


@router.get("/streams/{video_id}")
async def proxy_streams(video_id: str):
    """Return song metadata + related tracks in Piped's ``/streams/{id}`` shape.

    The frontend's audio picker and related-track mapper consume this. We never
    proxy media bytes — this is metadata plus a resolved direct-audio URL.

    Latency: the watch-playlist (related) and direct-audio lookups run
    CONCURRENTLY, and the whole route is bounded by ``STREAMS_BUDGET`` (10s)
    so it stays well under the browser's 12s client timeout. If a slow provider
    exceeds the budget we return whatever already resolved rather than hang.
    """
    vid = sanitize_youtube_id(video_id)

    payload: dict[str, Any] = {
        "title": "",
        "uploader": "",
        "thumbnailUrl": f"https://img.youtube.com/vi/{vid}/hqdefault.jpg",
        "duration": 0,
        "audioStreams": [],
        "videoStreams": [],
        "relatedStreams": [],
    }

    from app.routes.stream import get_direct_audio

    async def _task_direct() -> Optional[dict]:
        try:
            return await get_direct_audio(vid)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"direct audio failed for {vid}: {exc!s:.120}")
            return None

    related: list[dict] = []
    direct: Optional[dict] = None
    piped_payload: dict = {}

    async def _task_piped() -> dict:
        try:
            audio, video, meta = await _resolve_piped_streams(vid)
            if meta:
                return {"audio": audio, "video": video, "meta": meta}
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Piped streams fallback failed for {vid}: {exc!s:.120}")
        return {}

    # Concurrent + deadline-bounded resolve. From the HF host YouTube blocks
    # ytmusicapi and yt-dlp outright (they burn the whole budget timing out),
    # while a Piped instance often answers fast — so we run the Piped fallback
    # AT THE SAME TIME as the heavy providers and prefer whichever resolves
    # first, guaranteeing the browser never waits for blocked providers that
    # would push it past its 12s client timeout.
    async def _run():
        nonlocal related, direct, piped_payload
        related, direct, piped = await asyncio.gather(
            _resolve_watch_related(vid),
            _task_direct(),
            _task_piped(),
        )
        if not direct and not related:
            piped_payload = piped.get("meta") or {}
            if piped.get("audio") and not _direct_url_set(payload):
                payload["audioStreams"] = piped["audio"]
            if piped.get("video") and not _direct_url_set(payload):
                payload["videoStreams"] = piped["video"]

    try:
        await asyncio.wait_for(_run(), timeout=STREAMS_BUDGET)
    except asyncio.TimeoutError:
        logger.warning(f"/yt/streams budget exceeded for {vid}; returning partial")

    if direct and direct.get("audioUrl"):
        payload["videoStreams"].append({
            "url": direct["audioUrl"],
            "mimeType": direct.get("mimeType") or "audio/mp4",
            "bitrate": 0,
            "videoOnly": False,
        })
        payload["audioStreams"].append({
            "url": direct["audioUrl"],
            "mimeType": direct.get("mimeType") or "audio/mp4",
            "bitrate": 0,
        })
        payload["title"] = str(direct.get("title") or "")
        payload["duration"] = int(direct.get("duration") or 0)

    # Merge related (watch playlist wins; else Piped relatedStreams).
    if related:
        payload["relatedStreams"] = related
    elif piped_payload:
        payload["relatedStreams"] = _piped_related_items(piped_payload)

    # Metadata niceties from Piped if the direct descriptor didn't carry them.
    if piped_payload:
        payload["title"] = payload["title"] or str(piped_payload.get("title") or "")
        payload["uploader"] = payload["uploader"] or str(piped_payload.get("uploader") or "")
        payload["duration"] = payload["duration"] or int(piped_payload.get("duration") or 0)
        if piped_payload.get("thumbnailUrl"):
            payload["thumbnailUrl"] = str(piped_payload["thumbnailUrl"])

    return {"success": True, "data": payload}


def _direct_url_set(payload: dict) -> bool:
    return bool(payload.get("audioStreams"))


# ---------------------------------------------------------------------------
# Related / radio tracks
# ---------------------------------------------------------------------------


@router.get("/related/{video_id}")
async def proxy_related(
    video_id: str,
    exclude: str = Query("", description="Comma-separated videoIds to exclude"),
):
    """Return related/radio tracks for a seed videoId.

    Primary: ytmusicapi ``get_watch_playlist``. Fallback: server-side Piped
    ``/streams/{id}`` relatedStreams. This is the backend replacement for the
    browser's ``resolveRelatedOnBrowser``.
    """
    vid = sanitize_youtube_id(video_id)
    excluded = set([x for x in (exclude or "").split(",") if x])
    songs: list[dict] = []
    seen: set[str] = set()

    try:
        from app.services.ytmusic import call_ytmusic_safe

        watch = await asyncio.to_thread(
            lambda: call_ytmusic_safe("get_watch_playlist", videoId=vid, limit=20)
        )
        for t in (watch or {}).get("tracks") or []:
            if not isinstance(t, dict):
                continue
            rvid = str(t.get("videoId") or "").strip()
            title = str(t.get("title") or "").strip()
            if not rvid or rvid == vid or rvid in excluded or rvid in seen or not title:
                continue
            seen.add(rvid)
            songs.append({
                "videoId": rvid,
                "title": title,
                "artist": _piped_artist(t.get("artists")),
                "thumbnail": _piped_pick_thumb(t.get("thumbnail") or t.get("thumbnails"), rvid),
                "duration": int(t.get("length") or 0),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"ytmusic related failed for {vid}: {exc!s:.120}")

    if not songs:
        # Fallback: Piped relatedStreams.
        try:
            client = get_http_client()
            base = _pick_piped_base()
            resp = await client.get(f"{base}/streams/{vid}", timeout=PIPED_TIMEOUT)
            if resp.status_code == 200:
                for r in (resp.json().get("relatedStreams") or []):
                    if not isinstance(r, dict):
                        continue
                    rvid = str(_extract_video_id(r.get("url") or "") or "").strip()
                    title = str(r.get("title") or "").strip()
                    if not rvid or rvid == vid or rvid in excluded or rvid in seen or not title:
                        continue
                    if r.get("type") and r["type"] != "stream":
                        continue
                    seen.add(rvid)
                    songs.append({
                        "videoId": rvid,
                        "title": title,
                        "artist": str(r.get("uploaderName") or "Unknown Artist"),
                        "thumbnail": str(r.get("thumbnail") or ""),
                        "duration": int(r.get("duration") or 0),
                    })
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Piped related failed for {vid}: {exc!s:.120}")

    return {"success": True, "data": {"songs": songs}}