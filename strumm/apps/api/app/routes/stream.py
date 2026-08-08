"""Lightweight stream resolution endpoint.

No yt-dlp, ffmpeg, proxy scraping, or audio downloads.
The backend returns only song metadata. The frontend uses YouTube's iframe API
for actual playback, ensuring instant start and zero server-side media processing.
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Path, Query, BackgroundTasks
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
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Image proxy failed: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to load image.")
