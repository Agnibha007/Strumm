import asyncio
import logging
import os
import re
import shutil
import sys
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.routes.dependencies import get_current_user
from app.services.log_redaction import redact_sensitive
from app.services.youtube_cookies import ytdlp_cookie_cli_args

logger = logging.getLogger("strumm-song-downloads")
router = APIRouter(prefix="/downloads", tags=["song-downloads"])

def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        logger.warning("Invalid %s value; using default %s", name, default)
        return default
    return max(minimum, min(value, maximum))


# Keep download resource use configurable per deployment. Small EC2 instances
# should run one conversion at a time; larger hosts can raise this explicitly.
MAX_CONCURRENT_DOWNLOADS = _bounded_env_int("MAX_CONCURRENT_DOWNLOADS", 3, 1, 8)
DOWNLOAD_START_TIMEOUT_SECONDS = _bounded_env_int("DOWNLOAD_START_TIMEOUT_SECONDS", 75, 10, 180)
STREAM_CHUNK_SIZE = _bounded_env_int("DOWNLOAD_STREAM_CHUNK_KB", 64, 16, 256) * 1024
MAX_DOWNLOAD_BYTES = _bounded_env_int("MAX_DOWNLOAD_MB", 500, 1, 2048) * 1024 * 1024
MAX_PROCESS_STDERR_BYTES = 8192
MAX_LOG_DIAGNOSTIC_CHARS = 1200
_DIAGNOSTIC_URL_RE = re.compile(r"(?i)\bhttps?://[^\s<>\"']+")
_DIAGNOSTIC_CREDENTIAL_RE = re.compile(
    r"(?im)\b(cookie|set-cookie|authorization|proxy-authorization|x-goog-authuser)"
    r"\b\s*[:=]\s*[^\r\n]+"
)
_DIAGNOSTIC_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*")
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


def _sanitize_process_stderr(raw: bytes | str) -> str:
    """Return a compact subprocess diagnostic without URLs or credentials."""
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = _DIAGNOSTIC_URL_RE.sub("[URL REDACTED]", text)
    text = _DIAGNOSTIC_CREDENTIAL_RE.sub(r"\1=[REDACTED]", text)
    text = _DIAGNOSTIC_BEARER_RE.sub("Bearer [REDACTED]", text)
    text = redact_sensitive(text)
    text = " ".join(part.strip() for part in text.splitlines() if part.strip())
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    if len(text) > MAX_LOG_DIAGNOSTIC_CHARS:
        text = "…" + text[-(MAX_LOG_DIAGNOSTIC_CHARS - 1):]
    return text


async def _capture_process_stderr(stream) -> str:
    """Continuously drain stderr while retaining only its final bounded bytes."""
    if stream is None:
        return ""
    captured = bytearray()
    while True:
        chunk = await stream.read(2048)
        if not chunk:
            break
        captured.extend(chunk)
        if len(captured) > MAX_PROCESS_STDERR_BYTES:
            del captured[:-MAX_PROCESS_STDERR_BYTES]
    return _sanitize_process_stderr(bytes(captured))


async def _stderr_task_result(task: asyncio.Task | None) -> str:
    if task is None:
        return ""
    try:
        return await task
    except Exception as exc:
        logger.debug("Unable to collect subprocess stderr (%s)", type(exc).__name__)
        return ""


async def _wait_for_stderr_tasks(*tasks: asyncio.Task | None) -> None:
    active_tasks = [task for task in tasks if task is not None]
    if active_tasks:
        await asyncio.gather(*active_tasks, return_exceptions=True)


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


async def _start_ytdlp_mp3_stream(video_id: str, provider: str = "yt-dlp") -> AsyncIterator[bytes]:
    source = None
    encoder = None
    pump_task = None
    source_stderr_task = None
    encoder_stderr_task = None
    try:
        source_command = (
            _ytdlp_command(video_id)
            if provider == "yt-dlp"
            else ["/usr/local/bin/strumm-ytdl-go", video_id]
        )
        source = await asyncio.create_subprocess_exec(
            *source_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        source_stderr_task = asyncio.create_task(_capture_process_stderr(source.stderr))
        encoder = await asyncio.create_subprocess_exec(
            *_ffmpeg_command(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        encoder_stderr_task = asyncio.create_task(_capture_process_stderr(encoder.stderr))
        pump_task = asyncio.create_task(_pipe_audio(source, encoder))
        first_chunk = await asyncio.wait_for(
            encoder.stdout.read(STREAM_CHUNK_SIZE),
            timeout=DOWNLOAD_START_TIMEOUT_SECONDS,
        )
        if not first_chunk:
            await pump_task
            source_code = await source.wait()
            encoder_code = await encoder.wait()
            source_stderr = await _stderr_task_result(source_stderr_task)
            encoder_stderr = await _stderr_task_result(encoder_stderr_task)
            logger.warning(
                "Song download failed for %s (provider=%s, source=%s, ffmpeg=%s); "
                "source stderr: %s; ffmpeg stderr: %s",
                video_id,
                provider,
                source_code,
                encoder_code,
                source_stderr or "<empty>",
                encoder_stderr or "<empty>",
            )
            raise HTTPException(
                status_code=502,
                detail=f"{provider} could not resolve an audio stream for this track.",
            )
    except asyncio.CancelledError:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        await _wait_for_stderr_tasks(source_stderr_task, encoder_stderr_task)
        raise
    except asyncio.TimeoutError as exc:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        source_stderr, encoder_stderr = await asyncio.gather(
            _stderr_task_result(source_stderr_task),
            _stderr_task_result(encoder_stderr_task),
        )
        logger.warning(
            "Song download timed out for %s via %s after %ss; "
            "source stderr: %s; ffmpeg stderr: %s",
            video_id,
            provider,
            DOWNLOAD_START_TIMEOUT_SECONDS,
            source_stderr or "<empty>",
            encoder_stderr or "<empty>",
        )
        raise HTTPException(
            status_code=504,
            detail=f"{provider} timed out while resolving this track. Try again shortly.",
        ) from exc
    except HTTPException:
        if pump_task and not pump_task.done():
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        await _wait_for_stderr_tasks(source_stderr_task, encoder_stderr_task)
        raise
    except FileNotFoundError as exc:
        if pump_task:
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        await _stop_process(encoder)
        await _stop_process(source)
        await _wait_for_stderr_tasks(source_stderr_task, encoder_stderr_task)
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
        source_stderr, encoder_stderr = await asyncio.gather(
            _stderr_task_result(source_stderr_task),
            _stderr_task_result(encoder_stderr_task),
        )
        logger.error(
            "Unable to start song download for %s via %s (%s); "
            "source stderr: %s; ffmpeg stderr: %s",
            video_id,
            provider,
            type(exc).__name__,
            source_stderr or "<empty>",
            encoder_stderr or "<empty>",
        )
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
                source_stderr, encoder_stderr = await asyncio.gather(
                    _stderr_task_result(source_stderr_task),
                    _stderr_task_result(encoder_stderr_task),
                )
                logger.warning(
                    "Audio stream ended with a process error for %s via %s (source=%s, ffmpeg=%s); "
                    "source stderr: %s; ffmpeg stderr: %s",
                    video_id,
                    provider,
                    source_code,
                    encoder_code,
                    source_stderr or "<empty>",
                    encoder_stderr or "<empty>",
                )
        finally:
            if pump_task and not pump_task.done():
                pump_task.cancel()
                await asyncio.gather(pump_task, return_exceptions=True)
            await _stop_process(encoder)
            await _stop_process(source)
            await asyncio.gather(
                source_stderr_task, encoder_stderr_task, return_exceptions=True
            )

    return stream()


async def _download_song_with_provider(
    payload: SongDownloadRequest,
    current_user: dict,
    provider: str,
):
    video_id = payload.video_id.strip()
    if not YOUTUBE_ID_PATTERN.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="A valid YouTube video ID is required.")
    if not payload.rights_confirmed:
        raise HTTPException(
            status_code=400,
            detail="Confirm that you own this track or have permission to download it.",
        )
    if provider == "ytdl-go" and not os.path.isfile("/usr/local/bin/strumm-ytdl-go"):
        raise HTTPException(status_code=503, detail="The Go audio resolver is not installed.")
    if _download_semaphore.locked():
        raise HTTPException(status_code=503, detail="Downloads are busy. Try again shortly.")
    await _download_semaphore.acquire()
    try:
        if provider == "yt-dlp":
            audio_stream = await _start_ytdlp_mp3_stream(video_id)
        else:
            audio_stream = await _start_ytdlp_mp3_stream(video_id, provider=provider)
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
        "X-Download-Provider": provider,
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

    logger.info("Starting %s MP3 stream for user %s, video %s", provider, current_user.get("id"), video_id)
    return StreamingResponse(
        response_stream(),
        media_type="audio/mpeg",
        headers=headers,
    )


@router.post("/song")
async def download_song(
    payload: SongDownloadRequest,
    current_user: dict = Depends(get_current_user),
):
    return await _download_song_with_provider(payload, current_user, "yt-dlp")


@router.post("/song/ytdl-go")
async def download_song_ytdl_go(
    payload: SongDownloadRequest,
    current_user: dict = Depends(get_current_user),
):
    return await _download_song_with_provider(payload, current_user, "ytdl-go")
