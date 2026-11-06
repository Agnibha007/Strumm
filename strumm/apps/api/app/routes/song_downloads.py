import asyncio
import logging
import re
import shutil
import sys
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.routes.dependencies import get_current_user
from app.services.youtube_cookies import ytdlp_cookie_cli_args

logger = logging.getLogger("strumm-song-downloads")
router = APIRouter(prefix="/downloads", tags=["song-downloads"])

MAX_CONCURRENT_DOWNLOADS = 3
DOWNLOAD_START_TIMEOUT_SECONDS = 75
STREAM_CHUNK_SIZE = 64 * 1024
MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
YOUTUBE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
_download_semaphore = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)


class SongDownloadRequest(BaseModel):
    video_id: str = Field(..., alias="videoId", min_length=11, max_length=11)
    title: str = Field("", max_length=200)
    artist: str = Field("", max_length=120)
    duration: float = Field(0, ge=0, le=86400)
    rights_confirmed: bool = Field(False, alias="rightsConfirmed")


def _safe_filename(title: str, video_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", title.strip()).strip(" .-_")
    return (value[:90] or f"strumm-{video_id}") + ".mp3"


def _ytdlp_command(video_id: str) -> list[str]:
    executable = shutil.which("yt-dlp")
    if executable:
        command = [executable]
    else:
        command = [sys.executable, "-m", "yt_dlp"]
    return command + [
        "--quiet",
        "--no-warnings",
        "--no-progress",
        "--no-playlist",
        "--no-cache-dir",
        "--no-part",
        "--socket-timeout", "20",
        "--retries", "1",
        "--fragment-retries", "1",
        "--format", "bestaudio/best",
        "--output", "-",
        *ytdlp_cookie_cli_args(),
        "https://www.youtube.com/watch?v=" + video_id,
    ]


def _ffmpeg_command() -> list[str]:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise HTTPException(status_code=503, detail="The audio conversion service is unavailable.")
    return [
        executable,
        "-hide_banner",
        "-loglevel", "error",
        "-i", "pipe:0",
        "-map", "0:a:0",
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-f", "mp3",
        "pipe:1",
    ]


async def _pipe_audio(source: asyncio.subprocess.Process, encoder: asyncio.subprocess.Process):
    try:
        while True:
            chunk = await source.stdout.read(STREAM_CHUNK_SIZE)
            if not chunk:
                break
            encoder.stdin.write(chunk)
            await encoder.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        await _stop_process(source)
    finally:
        if encoder.stdin and not encoder.stdin.is_closing():
            encoder.stdin.close()
            try:
                await encoder.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass


async def _stop_process(process: asyncio.subprocess.Process | None):
    if process is None or process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def _start_ytdlp_mp3_stream(video_id: str) -> AsyncIterator[bytes]:
    source = None
    encoder = None
    pump_task = None
    try:
        source = await asyncio.create_subprocess_exec(
            *_ytdlp_command(video_id),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        encoder = await asyncio.create_subprocess_exec(
            *_ffmpeg_command(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        pump_task = asyncio.create_task(_pipe_audio(source, encoder))
        first_chunk = await asyncio.wait_for(
            encoder.stdout.read(STREAM_CHUNK_SIZE),
            timeout=DOWNLOAD_START_TIMEOUT_SECONDS,
        )
        if not first_chunk:
            await pump_task
            source_code = await source.wait()
            encoder_code = await encoder.wait()
            logger.warning(
                "yt-dlp download failed for %s (yt-dlp=%s, ffmpeg=%s)",
                video_id,
                source_code,
                encoder_code,
            )
            raise HTTPException(
                status_code=502,
                detail="yt-dlp could not resolve an audio stream for this track.",
            )
    except asyncio.CancelledError:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        raise
    except asyncio.TimeoutError as exc:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        raise HTTPException(
            status_code=504,
            detail="yt-dlp timed out while resolving this track. Try again shortly.",
        ) from exc
    except HTTPException:
        if pump_task and not pump_task.done():
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        raise
    except FileNotFoundError as exc:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        raise HTTPException(
            status_code=503,
            detail="The audio download service is not installed correctly.",
        ) from exc
    except Exception as exc:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        logger.exception("Unable to start yt-dlp streaming for %s", video_id)
        raise HTTPException(status_code=502, detail="Unable to start the audio download.") from exc

    async def stream():
        try:
            yield first_chunk
            while True:
                chunk = await encoder.stdout.read(STREAM_CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
            await pump_task
            source_code = await source.wait()
            encoder_code = await encoder.wait()
            if source_code != 0 or encoder_code != 0:
                logger.warning(
                    "Audio stream ended with a process error for %s (yt-dlp=%s, ffmpeg=%s)",
                    video_id,
                    source_code,
                    encoder_code,
                )
        finally:
            if pump_task and not pump_task.done():
                pump_task.cancel()
                await asyncio.gather(pump_task, return_exceptions=True)
            await _stop_process(encoder)
            await _stop_process(source)

    return stream()


@router.post("/song")
async def download_song(
    payload: SongDownloadRequest,
    current_user: dict = Depends(get_current_user),
):
    video_id = payload.video_id.strip()
    if not YOUTUBE_ID_PATTERN.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="A valid YouTube video ID is required.")
    if not payload.rights_confirmed:
        raise HTTPException(
            status_code=400,
            detail="Confirm that you own this track or have permission to download it.",
        )
    if _download_semaphore.locked():
        raise HTTPException(status_code=503, detail="Downloads are busy. Try again shortly.")
    await _download_semaphore.acquire()
    try:
        audio_stream = await _start_ytdlp_mp3_stream(video_id)
    except asyncio.CancelledError:
        _download_semaphore.release()
        raise
    except Exception:
        _download_semaphore.release()
        raise

    filename = _safe_filename(payload.title, video_id)
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
        "X-Download-Provider": "yt-dlp",
        "X-Download-Source-Url": "https://www.youtube.com/watch?v=" + video_id,
    }

    async def response_stream():
        total = 0
        try:
            async for chunk in audio_stream:
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError("The MP3 stream exceeded the 500 MiB download limit.")
                yield chunk
        finally:
            _download_semaphore.release()

    logger.info("Starting direct yt-dlp MP3 stream for user %s, video %s", current_user.get("id"), video_id)
    return StreamingResponse(
        response_stream(),
        media_type="audio/mpeg",
        headers=headers,
    )
