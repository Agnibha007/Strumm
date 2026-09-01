"""Stream resolution endpoints.

Primary playback is server-agnostic: the frontend uses YouTube's iframe API for
instant, zero-processing playback. For background/lock-screen listening (where
mobile browsers suspend iframes), `/play/{id}` additionally extracts a direct
audio URL via yt-dlp so the host page can play it in an `<audio>` element, and
`/audio-proxy` streams that URL through the backend as a CORS/network fallback.
No media is downloaded or stored — only metadata and a forwardable stream URL.
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Path, Query, BackgroundTasks, Request
from fastapi.responses import StreamingResponse
import asyncio

from app.database import mongodb as db
from app.services.security import sanitize_youtube_id

logger = logging.getLogger("strumm-stream")
router = APIRouter(tags=["stream"])


async def get_song_metadata(video_id: str) -> Optional[dict]:
    """Fetch song metadata from YTMusic or local cache."""
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

    # 2. Fetch from YTMusic
    try:
        from app.services.ytmusic import call_ytmusic_safe
        watch = await asyncio.to_thread(lambda: call_ytmusic_safe("get_watch_playlist", videoId=video_id, limit=1))
        if watch and watch.get("tracks"):
            track = watch["tracks"][0]
            duration_sec = track.get("length") or 200
            artists_list = track.get("artists", [])
            artist_name = ", ".join(
                [a.get("name", "") for a in artists_list if a.get("name")]
            ) if artists_list else "Unknown Artist"
            thumbnails = track.get("thumbnail", [])
            thumb_url = thumbnails[-1].get("url", "") if thumbnails else (
                f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"
            )
            album_info = track.get("album")
            album_name = album_info.get("name", "") if album_info else ""

            res = {
                "videoId": video_id,
                "title": track.get("title", "Untitled Track"),
                "artist": artist_name,
                "thumbnail": thumb_url,
                "duration": duration_sec,
                "metadata": {"album": album_name},
            }
            cache_stream(cache_key_str, res)
            return res
    except Exception as e:
        logger.warning(f"Provider metadata fetch failed for {video_id}: {e}")

    # 3. Fallback with basic info
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
# googlevideo URL is unreachable from the client's network. Extracted URLs are
# signed for ~6h, so the 2h TTL cache stays safely under the expiry.

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
            logger.warning(
                f"yt-dlp audio extraction failed for {video_id} "
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


async def get_direct_audio(video_id: str) -> Optional[dict]:
    """Return a cached direct-audio descriptor, extracting on cache miss."""
    from app.services.cache import get_cached_stream, cache_stream, cache_key

    key = cache_key("audiostream", video_id)
    cached = get_cached_stream(key)
    if isinstance(cached, dict) and cached.get("audioUrl"):
        return cached

    try:
        info = await asyncio.to_thread(_run_ytdlp_extract, video_id)
    except Exception as exc:
        logger.warning(f"get_direct_audio failed for {video_id}: {exc!s:.160}")
        return None

    audio_url = _pick_best_audio(info)
    if not audio_url:
        return None

    result = {
        "videoId": video_id,
        "audioUrl": audio_url,
        "mimeType": _audio_mime(str(info.get("ext") or "")),
        "title": info.get("title"),
        "duration": info.get("duration"),
    }
    cache_stream(key, result)
    return result


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
    from app.services.security import assert_public_http_url
    from app.services.http_client import get_http_client

    try:
        safe_url = assert_public_http_url(url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid audio URL.") from exc

    client = get_http_client()
    upstream_headers = {"Referer": "https://www.youtube.com/"}
    if request.headers.get("range"):
        upstream_headers["Range"] = request.headers["range"]

    try:
        req = client.build_request("GET", safe_url, headers=upstream_headers)
        response = await client.send(req, stream=True)
    except Exception as exc:
        logger.warning(f"Audio proxy upstream error: {exc!s:.160}")
        raise HTTPException(status_code=502, detail="Unable to reach audio source.")

    async def iter_bytes():
        try:
            async for chunk in response.aiter_raw():
                if chunk:
                    yield chunk
        finally:
            await response.aclose()

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
        from app.services.security import assert_public_http_url
        from app.services.http_client import safe_http_get

        safe_url = assert_public_http_url(url)
        response = await safe_http_get(safe_url, timeout=8.0)
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
