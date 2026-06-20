import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path as FilePath

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from yt_dlp import YoutubeDL
from app.database import mongodb as db
from app.services.security import assert_public_http_url, sanitize_enum, sanitize_youtube_id
import logging
import httpx

logger = logging.getLogger("strumm-stream")
router = APIRouter(tags=["stream"])

def safe_download_filename(value: str) -> str:
    cleaned = "".join(
        char for char in value.replace("\x00", "")
        if char.isalnum() or char in {" ", ".", "-", "_"}
    ).strip()
    return cleaned[:160] or "strumm-track"

def get_free_proxies() -> list[str]:
    try:
        import httpx
        url = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all"
        resp = httpx.get(url, timeout=5.0)
        if resp.status_code == 200:
            return [p.strip() for p in resp.text.split("\n") if p.strip()]
    except Exception as e:
        logger.warning(f"Failed to fetch proxy list: {str(e)}")
    return []

def extract_youtube_mp3(video_id: str, title_hint: str) -> tuple[str, str]:
    tmp_dir = tempfile.mkdtemp(prefix="strumm-download-")
    outtmpl = str(FilePath(tmp_dir) / "%(title).180B.%(ext)s")
    source_url = f"https://www.youtube.com/watch?v={video_id}"

    base_options = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
    }

    last_error = None
    # 1. Try direct connection
    try:
        with YoutubeDL(base_options) as ydl:
            info = ydl.extract_info(source_url, download=True)
        mp3_files = list(FilePath(tmp_dir).glob("*.mp3"))
        if mp3_files:
            filename = safe_download_filename(info.get("title") or title_hint)
            return str(mp3_files[0]), f"{filename}.mp3"
    except Exception as e:
        last_error = e
        logger.info(f"Direct download failed for {video_id}, attempting proxy rotation. Error: {str(e)[:150]}")

    # 2. Try proxy rotation fallback
    proxies = get_free_proxies()
    import random
    random.shuffle(proxies)
    
    for proxy in proxies[:10]:
        proxy_url = f"http://{proxy}"
        options = base_options.copy()
        options["proxy"] = proxy_url
        try:
            with YoutubeDL(options) as ydl:
                info = ydl.extract_info(source_url, download=True)
            mp3_files = list(FilePath(tmp_dir).glob("*.mp3"))
            if mp3_files:
                filename = safe_download_filename(info.get("title") or title_hint)
                return str(mp3_files[0]), f"{filename}.mp3"
        except Exception as e:
            last_error = e
            logger.info(f"Proxy download failed with {proxy_url}: {str(e)[:100]}")

    shutil.rmtree(tmp_dir, ignore_errors=True)
    raise RuntimeError(f"All download attempts failed. Last error: {str(last_error)}")

def cleanup_download(path: str):
    shutil.rmtree(str(FilePath(path).parent), ignore_errors=True)

QUALITY_BITRATES = {
    "data-saver": "64k",
    "balanced": "128k",
}

async def drain_stream(stream):
    if not stream:
        return
    while True:
        chunk = await stream.read(1024)
        if not chunk:
            break

async def stream_original_audio(safe_url: str):
    async with httpx.AsyncClient(
        headers={"User-Agent": "Strumm/1.0"},
        follow_redirects=True,
        timeout=30.0,
    ) as client:
        async with client.stream("GET", safe_url) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes(1024 * 64):
                yield chunk

async def stream_transcoded_audio(safe_url: str, bitrate: str):
    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=503, detail="Audio transcoding is not available on this server.")

    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-headers",
        "User-Agent: Strumm/1.0\r\n",
        "-i",
        safe_url,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        "-f",
        "mp3",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_task = asyncio.create_task(drain_stream(process.stderr))

    try:
        assert process.stdout is not None
        while True:
            chunk = await process.stdout.read(1024 * 64)
            if not chunk:
                break
            yield chunk
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
        await stderr_task

@router.get("/resolve/{id}")
async def resolve_track(
    id: str = Path(..., description="The YouTube videoId to resolve")
):
    try:
        id = sanitize_youtube_id(id)
        database = db.get_db()
        
        # 1. Search database to see if we already have song metadata cached
        # Check inside playlists, likedsongs, or playback histories
        song_doc = await database[db.PLAYLISTS].find_one(
            {"songs.videoId": id},
            {"songs.$": 1}
        )
        
        song_data = None
        if song_doc and "songs" in song_doc and len(song_doc["songs"]) > 0:
            song_data = song_doc["songs"][0]
        else:
            # Check liked songs
            liked_doc = await database[db.LIKED_SONGS].find_one({"song.videoId": id})
            if liked_doc:
                song_data = liked_doc["song"]
            else:
                # Check history
                hist_doc = await database[db.PLAYBACK_HISTORIES].find_one({"song.videoId": id})
                if hist_doc:
                    song_data = hist_doc["song"]

        if song_data:
            return {
                "success": True,
                "data": {
                    "videoId": song_data.get("videoId"),
                    "title": song_data.get("title"),
                    "artist": song_data.get("artist"),
                    "thumbnail": song_data.get("thumbnail"),
                    "duration": song_data.get("duration"),
                    "metadata": song_data.get("metadata", {}),
                    "streamUrl": f"https://www.youtube.com/watch?v={id}" # clients play via iframe API
                }
            }
        
        # 2. If it's a completely new track, return placeholders and fetch dynamically
        # Since it's client-side YouTube player, we can dynamically build info
        return {
            "success": True,
            "data": {
                "videoId": id,
                "title": f"YouTube Track ({id})",
                "artist": "Various Artists",
                "thumbnail": f"https://img.youtube.com/vi/{id}/hqdefault.jpg",
                "duration": 240, # default placeholder duration
                "metadata": {},
                "streamUrl": f"https://www.youtube.com/watch?v={id}"
            }
        }
        
    except Exception as e:
        logger.error(f"Error resolving track {id}: {str(e)}")
        return {
            "success": False,
            "error": f"Failed to resolve track metadata: {str(e)}"
        }

@router.get("/podcast-audio")
async def stream_podcast_audio(
    url: str = Query(..., max_length=1500),
    quality: str = Query("balanced", max_length=20),
):
    try:
        safe_url = assert_public_http_url(url)
        cleaned_quality = sanitize_enum(quality, {"data-saver", "balanced", "high"}, "balanced")

        if cleaned_quality == "high":
            return StreamingResponse(
                stream_original_audio(safe_url),
                media_type="audio/mpeg",
                headers={"Cache-Control": "private, max-age=300"},
            )

        return StreamingResponse(
            stream_transcoded_audio(safe_url, QUALITY_BITRATES[cleaned_quality]),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-store"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Podcast audio stream failed: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to stream podcast audio.")

@router.get("/download/{id}")
async def download_track_mp3(
    id: str = Path(..., description="The YouTube videoId to export as MP3"),
    title: str = Query("strumm-track", max_length=180),
):
    try:
        video_id = sanitize_youtube_id(id)
        filename_hint = safe_download_filename(title)

        mp3_path, filename = await asyncio.to_thread(extract_youtube_mp3, video_id, filename_hint)
        return FileResponse(
            mp3_path,
            media_type="audio/mpeg",
            filename=filename,
            background=BackgroundTask(cleanup_download, mp3_path),
        )
    except Exception as e:
        logger.warning(f"MP3 export failed for {id}: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to export this track as MP3.")

@router.get("/image-proxy")
async def proxy_image(url: str = Query(..., max_length=1500)):
    try:
        safe_url = assert_public_http_url(url)
        async with httpx.AsyncClient(
            headers={"User-Agent": "Strumm/1.0"},
            follow_redirects=True,
            timeout=12.0,
        ) as client:
            response = await client.get(safe_url)
            response.raise_for_status()

        content_type = response.headers.get("content-type", "image/jpeg").split(";")[0].lower()
        if not content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="URL did not return an image.")

        return StreamingResponse(
            iter([response.content]),
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Image proxy failed: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to load image.")

@router.get("/download-audio")
async def download_audio(
    url: str = Query(..., max_length=1500),
    filename: str = Query("strumm-track.mp3", max_length=180),
):
    try:
        safe_url = assert_public_http_url(url)
        safe_filename = "".join(
            char for char in filename.replace("\x00", "")
            if char.isalnum() or char in {" ", ".", "-", "_"}
        ).strip() or "strumm-track.mp3"

        async def stream_audio():
            async with httpx.AsyncClient(
                headers={"User-Agent": "Strumm/1.0"},
                follow_redirects=True,
                timeout=30.0,
            ) as client:
                async with client.stream("GET", safe_url) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes(1024 * 64):
                        yield chunk

        return StreamingResponse(
            stream_audio(),
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": f'attachment; filename="{safe_filename}"',
                "Cache-Control": "no-store",
            },
        )
    except Exception as e:
        logger.warning(f"Audio download failed: {str(e)}")
        raise HTTPException(status_code=502, detail="Unable to download audio.")
