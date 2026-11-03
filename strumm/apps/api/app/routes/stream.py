"""Stream resolution endpoints.

Primary playback is server-agnostic: the frontend uses YouTube's iframe API for
instant, zero-processing playback. For background/lock-screen listening (where
mobile browsers suspend iframes), `/play/{id}` additionally extracts a direct
audio URL via yt-dlp so the host page can play it in an `<audio>` element, and
`/audio-proxy` streams that URL through the backend as a CORS/network fallback.
When yt-dlp is bot-blocked from this host (common on cloud egress IPs),
`/play` falls back to a public Piped instance's `/streams` endpoint so the
audio URL still resolves. No media is downloaded or stored — only metadata and
a forwardable stream URL.
"""

import logging
import os
import threading
import time
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Path, Query, BackgroundTasks, Request
from fastapi.responses import StreamingResponse
import asyncio

from app.database import mongodb as db
from app.services.security import sanitize_youtube_id

logger = logging.getLogger("strumm-stream")
router = APIRouter(tags=["stream"])

# ---------------------------------------------------------------------------
# yt-dlp blocked fast-fail
# ---------------------------------------------------------------------------
# From cloud egress IPs (HF Spaces / Render) YouTube commonly bot-blocks
# yt-dlp: every extraction burns the full socket timeout before failing with
# "EOF occurred in violation of protocol" / "Unable to download API page".
# Once that is observed, skip yt-dlp entirely for a while and go straight to
# the Piped fallback, so one blocked song doesn't serialize 15-30s of dead
# probing before every subsequent request. A successful extraction clears the
# block immediately; the TTL bounds how long a stale block can linger.
YTDLP_BLOCKED_TTL = float(os.getenv("YTDLP_BLOCKED_TTL", "300"))

_ytdlp_blocked_until: float = 0.0
_ytdlp_block_lock = threading.Lock()


def _classify_ytdlp_block(exc: BaseException) -> bool:
    """True when the yt-dlp failure looks like a host-wide block rather than a
    per-video problem (unavailable/private/region-locked videos must NOT trip
    the global breaker)."""
    text = f"{type(exc).__name__}: {exc}".lower()
    per_video = (
        "video unavailable" in text
        or "not available" in text
        or "private video" in text
        or "removed" in text
        or "unavailable" in text
        or "age-restricted" in text
        or "region" in text
        or "playlist unavailable" in text
    )
    if per_video:
        return False
    return any(
        kw in text
        for kw in (
            "eof occurred",
            "ssleof",
            "timed out",
            "timeout",
            "connection refused",
            "connection reset",
            "connection aborted",
            "connectionerror",
            "unable to download api page",
            "http error 403",
            "http error 429",
            "forbidden",
            "sign in to confirm",
            "bot",
            "tls",
            "ssl",
            "handshake",
        )
    )


def _ytdlp_blocked() -> bool:
    with _ytdlp_block_lock:
        return time.monotonic() < _ytdlp_blocked_until


def _mark_ytdlp_blocked() -> None:
    global _ytdlp_blocked_until
    with _ytdlp_block_lock:
        if time.monotonic() < _ytdlp_blocked_until:
            return
        _ytdlp_blocked_until = time.monotonic() + YTDLP_BLOCKED_TTL
    logger.warning(
        f"yt-dlp appears bot-blocked from this host; skipping it for "
        f"{YTDLP_BLOCKED_TTL:.0f}s and using the Piped fallback"
    )


def _clear_ytdlp_blocked() -> None:
    global _ytdlp_blocked_until
    with _ytdlp_block_lock:
        _ytdlp_blocked_until = 0.0


def _reset_ytdlp_block() -> None:
    """Clear any yt-dlp block state (tests / diagnostics)."""
    _clear_ytdlp_blocked()


async def get_song_metadata(video_id: str) -> Optional[dict]:
    """Fetch song metadata from local cache (DB or in-memory), never YouTube."""
    # 0. Check in-memory TTL cache first
    from app.services.cache import get_cached_stream, cache_stream
    cache_key_str = f"stream:{video_id}"
    cached = get_cached_stream(cache_key_str)
    if cached:
        return cached

    # 1. Check local database cache first
    database = db.get_db()
    song_doc = await database[db.PLAYLISTS].find_one(
        {"songs.videoId": video_id},
        {"songs.$": 1}
    )
    if song_doc and "songs" in song_doc and len(song_doc["songs"]) > 0:
        res = song_doc["songs"][0]
        cache_stream(cache_key_str, res)
        return res

    liked_doc = await database[db.LIKED_SONGS].find_one({"song.videoId": video_id})
    if liked_doc:
        res = liked_doc["song"]
        cache_stream(cache_key_str, res)
        return res

    hist_doc = await database[db.PLAYBACK_HISTORIES].find_one({"song.videoId": video_id})
    if hist_doc:
        res = hist_doc["song"]
        cache_stream(cache_key_str, res)
        return res

    # 2. Fallback with basic info (no server->YouTube egress; the client can
    #    resolve richer metadata directly via Piped in the browser).
    res = {
        "videoId": video_id,
        "title": f"YouTube Track ({video_id})",
        "artist": "Various Artists",
        "thumbnail": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
        "duration": 200,
        "metadata": {},
    }
    cache_stream(cache_key_str, res)
    return res


@router.get("/resolve/{id}")
async def resolve_track(
    background_tasks: BackgroundTasks,
    id: str = Path(..., description="The YouTube videoId to resolve"),
):
    """Return song metadata. Frontend handles actual playback via YouTube iframe."""
    try:
        video_id = sanitize_youtube_id(id)
        song_data = await get_song_metadata(video_id)

        return {
            "success": True,
            "data": {
                "videoId": song_data.get("videoId"),
                "title": song_data.get("title"),
                "artist": song_data.get("artist"),
                "thumbnail": song_data.get("thumbnail"),
                "duration": song_data.get("duration"),
                "metadata": song_data.get("metadata", {}),
                # Frontend uses this URL directly in YouTube iframe for playback
                "streamUrl": f"https://www.youtube.com/watch?v={video_id}",
            },
        }
    except Exception as e:
        logger.error(f"Error resolving track {id}: {str(e)}")
        return {
            "success": False,
            "error": "An internal error occurred.",
        }


# ---------------------------------------------------------------------------
# Direct audio — background / lock-screen playback
# ---------------------------------------------------------------------------
# The YouTube iframe pauses when mobile browsers background the page (screen
# locked). A host-page `<audio>` element keeps playing, so /play extracts a
# direct audio URL with yt-dlp (which handles YouTube's bot checks better than
# ytmusicapi) and /audio-proxy streams it back as a fallback when the direct
# googlevideo URL is unreachable from the client's network. If yt-dlp itself is
# bot-blocked from this host's IP, we fall back to a public Piped instance's
# /streams endpoint, which performs the YouTube fetch server-side. Extracted
# URLs are signed for ~6h, so the 2h TTL cache stays safely under the expiry.

AUDIO_FORMAT_ORDER = {"m4a": 3, "mp4": 2, "webm": 2, "opus": 1, "ogg": 1}


def _pick_best_audio(info: Optional[dict]) -> Optional[str]:
    """Return the best playable audio URL from a yt-dlp info dict.

    Prefer the already-selected ``url`` (set when a ``format`` is configured),
    otherwise scan ``formats`` for the highest-quality audio-only stream.
    """
    if not isinstance(info, dict):
        return None
    url = info.get("url")
    if isinstance(url, str) and url:
        return url

    best_score = -1.0
    best_url: Optional[str] = None
    formats = info.get("formats") or []
    for f in formats:
        if not isinstance(f, dict):
            continue
        u = f.get("url")
        if not isinstance(u, str) or not u:
            u = f.get("manifest_url")
        if not isinstance(u, str) or not u:
            continue
        vcodec = (f.get("vcodec") or "none").lower()
        ext = (f.get("ext") or f.get("extr") or "").lower()
        audio_only = vcodec in ("none", "audio only")
        score = (
            (1000.0 if audio_only else 0.0)
            + AUDIO_FORMAT_ORDER.get(ext, 0.0)
            + (float(f.get("tbr") or 0.0) / 1000.0)
        )
        if score > best_score:
            best_score = score
            best_url = u
    return best_url


def _run_ytdlp_extract(video_id: str) -> dict:
    """Extract audio info for ``video_id`` via yt-dlp (never downloads media)."""
    import yt_dlp

    url = f"https://www.youtube.com/watch?v={video_id}"
    attempts = [
        {},
        # tv/web clients commonly bypass anonymous bot-IP blocks.
        {"extractor_args": {"youtube": {"player_client": ["tv", "web"]}}},
    ]
    last_error: Optional[Exception] = None
    for override in attempts:
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "socket_timeout": 15,
            "retries": 1,
        }
        opts.update(override)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if _pick_best_audio(info):
                return info
            break  # info present but no audio URL — don't re-run with same payload
        except Exception as exc:  # noqa: BLE001 — surface as last_error
            last_error = exc
            # DEBUG: the caller (get_direct_audio / /yt/streams) logs ONE
            # consolidated line per video, so a blocked host does not produce
            # per-attempt warning spam for every track.
            logger.debug(
                f"yt-dlp audio extraction attempt failed for {video_id} "
                f"({'default' if not override else 'tv' }): {exc!s:.160}"
            )
    raise RuntimeError(f"No audio URL could be extracted for {video_id}: {last_error}")


def _audio_mime(ext: str) -> str:
    if ext in ("m4a", "mp4"):
        return "audio/mp4"
    if ext in ("webm", "opus"):
        return "audio/webm"
    if ext in ("ogg", "mp3", "aac"):
        return f"audio/{ext}"
    return "audio/mp4"


# ---------------------------------------------------------------------------
# Piped audio fallback — background audio when yt-dlp is bot-blocked
# ---------------------------------------------------------------------------
# YouTube blocks anonymous cloud egress IPs (yt-dlp fails with "EOF occurred
# in violation of protocol"). Public Piped instances perform the YouTube fetch
# server-side, so their ``/streams/{id}`` endpoint still yields playable audio
# URLs from the same cloud range that direct yt-dlp can't reach. This mirrors
# ``ytfallback.py``'s Piped search provider: same instance list (re-imported),
# same rotate-on-failure behavior, and no change to the client/server contract
# (``/play`` still just returns an ``audioUrl``).
#
# The live instance (``api.piped.private.coffee``) no longer returns discrete
# ``audioStreams``; it serves a combined 360p MP4 (itag 18, ``videoOnly:
# false``). An ``<audio>`` element plays just the audio track of an MP4, so we
# prioritize a real audio-only stream when present and otherwise fall back to
# the best combined MP4.


def _run_piped_extract(video_id: str) -> Optional[dict]:
    """Return a Piped audio descriptor for ``video_id``, or ``None`` on failure.

    Instance selection is delegated to the shared provider (``piped.py``):
    healthy instances first, cooldown for 403/429/5xx/526/timeouts, and the
    most-recently-successful instance preferred, so repeated playback does not
    hammer a known-bad instance.
    """
    from app.services.piped import piped_fetch_json_sync, PIPED_TIMEOUT

    found = piped_fetch_json_sync(
        f"/streams/{video_id}",
        params={"itag": "140"},
        timeout=PIPED_TIMEOUT,
        require_keys=("audioStreams", "videoStreams"),
    )
    if not found:
        return None
    _base, payload = found

    def _ext_from_mime(mime: str) -> str:
        ext = (mime or "").split("/")[-1].split(";")[0].lower()
        if ext == "m4a":
            return "m4a"
        if ext in ("mp4", "webm", "ogg", "opus", "aac", "mpeg"):
            return ext
        return "mp4"  # unknown sub-type — treat as MP4 container

    # 1. Prefer a dedicated audio-only stream.
    best_audio = None
    for s in payload.get("audioStreams") or []:
        if not isinstance(s, dict):
            continue
        u = (s.get("url") or "").strip()
        if not u:
            continue
        ext = _ext_from_mime(s.get("mimeType") or "")
        score = float(s.get("bitrate") or 0) + 100000.0
        if best_audio is None or score > best_audio[0]:
            best_audio = (score, u, ext)

    # 2. Otherwise use a combined stream (e.g. itag 18) — an ``<audio>``
    #    element plays just the audio track of an MP4, so this still works.
    #    The Odysee-mirrored ``player.odycdn.com`` LBRY streams 401 for
    #    browser/<audio> clients, so only the instance-proxied playback
    #    URLs (e.g. ``proxy.<instance>/videoplayback``) are usable.
    best_combined = None
    for s in payload.get("videoStreams") or []:
        if not isinstance(s, dict):
            continue
        if s.get("videoOnly"):
            continue  # no audio track — useless for playback
        u = (s.get("url") or "").strip()
        if not u:
            continue
        if "player.odycdn.com" in u:
            continue  # Odysee LBRY mirror returns 401 — not playable
        mime = (s.get("mimeType") or "").lower()
        # Prefer MP4 (widely playable); HLS needs the instance's aux stream
        # and libav params, so skip pure HLS manifests (handled elsewhere).
        if mime not in ("video/mp4", "audio/mp4", ""):
            continue
        ext = _ext_from_mime(s.get("mimeType") or "")
        # heuristically favor low-quality combined streams (audio-first use)
        score = 0.0
        if "/videoplayback" in u:
            score += 1000.0
        score += float(s.get("bitrate") or 0)
        if best_combined is None or score > best_combined[0]:
            best_combined = (score, u, ext)

    chosen = best_audio or best_combined
    if chosen:
        return {
            "videoId": video_id,
            "audioUrl": chosen[1],
            "mimeType": _audio_mime(chosen[2]),
            "title": payload.get("title") or "",
            "duration": payload.get("duration"),
        }
    return None


async def get_direct_audio(video_id: str) -> Optional[dict]:
    """Return a cached direct-audio descriptor, extracting on cache miss."""
    from app.services.cache import get_cached_stream, cache_stream, cache_key

    key = cache_key("audiostream", video_id)
    cached = get_cached_stream(key)
    if isinstance(cached, dict) and cached.get("audioUrl"):
        return cached

    info = None
    ytdlp_attempted = False
    if not _ytdlp_blocked():
        ytdlp_attempted = True
        try:
            info = await asyncio.to_thread(_run_ytdlp_extract, video_id)
        except Exception as exc:
            # Per-video problems (unavailable/private) stay per-video; host-wide
            # blocks (EOF / timeout / 403 API page) trip the global fast-fail.
            if _classify_ytdlp_block(exc):
                _mark_ytdlp_blocked()
            else:
                logger.warning(f"yt-dlp could not resolve {video_id}: {exc!s:.160}")
            info = None
    else:
        logger.debug(f"yt-dlp blocked — skipping for {video_id}")

    audio_url = _pick_best_audio(info) if isinstance(info, dict) else None
    if audio_url:
        _clear_ytdlp_blocked()
        result = {
            "videoId": video_id,
            "audioUrl": audio_url,
            "mimeType": _audio_mime(str(info.get("ext") or "")),
            "title": info.get("title"),
            "duration": info.get("duration"),
        }
        cache_stream(key, result)
        return result

    # yt-dlp is bot-blocked from this host (common on cloud egress IPs) or
    # yielded no audio. Fall back to a Piped instance so background / lock-
    # screen audio still works.
    fallback = await asyncio.to_thread(_run_piped_extract, video_id)
    if fallback:
        cache_stream(key, fallback)
        return fallback

    return None


@router.get("/play/{id}")
async def play_track(id: str = Path(..., description="The YouTube videoId to play")):
    """Resolve a direct audio URL for background / lock-screen playback.

    Returns the extracted audio URL the host page can feed an ``<audio>``
    element without an iframe. Status 200 with ``success: false`` means no
    audio is available (e.g. sign-in required) — callers fall back to the
    iframe player, which is unaffected.
    """
    video_id = sanitize_youtube_id(id)
    audio = await get_direct_audio(video_id)
    if not audio:
        return {
            "success": False,
            "error": "Direct audio is not available for this track.",
        }
    return {"success": True, "data": audio}


@router.get("/audio-proxy")
async def proxy_audio(
    request: Request,
    url: str = Query(..., max_length=2000, description="Direct audio URL to proxy"),
):
    """Stream a resolved audio URL through the backend (CORS/network fallback).

    Forwards ``Range`` headers so the host ``<audio>`` element can seek. Used
    when playing the googlevideo URL directly fails from the client's network.
    """
    from app.services.security import create_pinned_client

    try:
        client = create_pinned_client(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid audio URL.") from exc

    upstream_headers = {"Referer": "https://www.youtube.com/"}
    if request.headers.get("range"):
        upstream_headers["Range"] = request.headers["range"]

    try:
        req = client.build_request("GET", url, headers=upstream_headers)
        response = await client.send(req, stream=True)
    except Exception as exc:
        await client.aclose()
        logger.warning(f"Audio proxy upstream error: {exc!s:.160}")
        raise HTTPException(status_code=502, detail="Unable to reach audio source.")

    async def iter_bytes():
        try:
            async for chunk in response.aiter_raw():
                if chunk:
                    yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    headers = {
        k: v
        for k, v in response.headers.items()
        if k.lower()
        in ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified")
    }
    headers["Access-Control-Allow-Origin"] = "*"
    return StreamingResponse(
        iter_bytes(),
        status_code=response.status_code,
        headers=headers,
        media_type=response.headers.get("content-type", "audio/mp4"),
    )


@router.get("/podcast-audio")
async def stream_podcast_audio(
    url: str = Query(..., max_length=1500),
    quality: str = Query("balanced", max_length=20),
):
    """Return the podcast audio URL for frontend to play directly."""
    try:
        from app.services.security import assert_public_http_url
        safe_url = assert_public_http_url(url)
        return {
            "success": True,
            "data": {
                "streamUrl": safe_url,
                "quality": quality,
                "note": "Frontend should stream this URL directly.",
            },
        }
    except Exception as e:
        logger.warning(f"Podcast audio stream failed: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to stream podcast audio.")


@router.get("/image-proxy")
async def proxy_image(
    url: str = Query(..., max_length=1500),
    w: int = Query(0, ge=0, le=1000, description="Desired width in pixels. 0 = original size."),
    quality: int = Query(80, ge=10, le=100, description="JPEG/WebP compression quality."),
):
    """Proxy and optionally optimize external images.

    Fetches an external image, optionally resizes it to the desired width,
    converts to WebP for modern browsers, and returns with aggressive caching.
    """
    try:
        from app.services.http_client import safe_http_get

        response = await safe_http_get(url, timeout=8.0)
        response.raise_for_status()

        raw_bytes = response.content
        content_type = response.headers.get("content-type", "image/jpeg").split(";")[0].lower()

        if not content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="URL did not return an image.")

        # Attempt server-side image optimization with Pillow (run in thread pool to avoid blocking)
        optimized = None
        output_mime = content_type

        try:
            import asyncio
            from PIL import Image
            import io

            def optimize_image(raw: bytes, target_w: int, q: int) -> tuple[bytes, str]:
                img = Image.open(io.BytesIO(raw))

                # Convert RGBA/P to RGB
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGBA" if img.mode == "P" and img.info.get("transparency") else "RGB")

                orig_w, orig_h = img.size

                # Resize if requested width is smaller than original
                if 0 < target_w < orig_w:
                    ratio = target_w / orig_w
                    new_h = int(orig_h * ratio)
                    img = img.resize((target_w, new_h), Image.LANCZOS)

                buf = io.BytesIO()
                if img.mode == "RGBA":
                    img.save(buf, format="PNG", optimize=True)
                    return buf.getvalue(), "image/png"
                else:
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    img.save(buf, format="WEBP", quality=q, method=6)
                    return buf.getvalue(), "image/webp"

            optimized, output_mime = await asyncio.to_thread(optimize_image, raw_bytes, w, quality)
        except ImportError:
            # Pillow not installed — pass through raw bytes
            logger.warning("Pillow not installed; serving image unoptimized.")
        except Exception as e:
            logger.warning(f"Image optimization failed (serving original): {e}")

        if optimized is None:
            optimized = raw_bytes

        from fastapi.responses import Response
        return Response(
            content=optimized,
            media_type=output_mime,
            headers={
                "Cache-Control": "public, max-age=604800, immutable",
                "CDN-Cache-Control": "public, max-age=604800, immutable",
                "Access-Control-Allow-Origin": "*",
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Image proxy failed: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to load image.")
