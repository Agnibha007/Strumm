import asyncio
import shutil
import tempfile
from pathlib import Path as FilePath

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from yt_dlp import YoutubeDL
from app.database import mongodb as db
from app.services.security import assert_public_http_url, sanitize_youtube_id
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

def extract_youtube_mp3(video_id: str, title_hint: str) -> tuple[str, str]:
    tmp_dir = tempfile.mkdtemp(prefix="strumm-download-")
    outtmpl = str(FilePath(tmp_dir) / "%(title).180B.%(ext)s")
    source_url = f"https://www.youtube.com/watch?v={video_id}"

    options = {
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

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(source_url, download=True)
        mp3_files = list(FilePath(tmp_dir).glob("*.mp3"))
        if not mp3_files:
            raise RuntimeError("MP3 export did not produce a file.")

        filename = safe_download_filename(info.get("title") or title_hint)
        return str(mp3_files[0]), f"{filename}.mp3"
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

def cleanup_download(path: str):
    shutil.rmtree(str(FilePath(path).parent), ignore_errors=True)

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
