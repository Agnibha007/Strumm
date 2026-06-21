import os
import time
import random
import logging
import asyncio
import httpx
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
from yt_dlp import YoutubeDL
from fastapi import APIRouter, HTTPException, Path, Query, BackgroundTask
from fastapi.responses import FileResponse, StreamingResponse
from app.database import mongodb as db
from app.services.security import assert_public_http_url, sanitize_enum, sanitize_youtube_id

logger = logging.getLogger("strumm-stream")
router = APIRouter(tags=["stream"])

# Collections
STREAM_CACHE = "stream_cache"
PROXY_CACHE = "proxy_cache"

QUALITY_BITRATES = {
    "data-saver": "64k",
    "balanced": "128k",
}

# Dynamic priorities for methods
DEFAULT_METHOD_ORDER = ["direct", "cookies", "proxyPool"]

def safe_download_filename(value: str) -> str:
    cleaned = "".join(
        char for char in value.replace("\x00", "")
        if char.isalnum() or char in {" ", ".", "-", "_"}
    ).strip()
    return cleaned[:160] or "strumm-track"

async def get_free_proxies() -> list[str]:
    try:
        url = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all"
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                return [p.strip() for p in resp.text.split("\n") if p.strip()]
    except Exception as e:
        logger.warning(f"Failed to fetch proxy list: {str(e)}")
    return []

# Helper to find cookies file path
def get_cookies_path() -> Optional[str]:
    # Look for a cookies file in standard locations
    possible_paths = [
        "cookies.txt",
        "../cookies.txt",
        "../../cookies.txt",
        os.path.join(os.getcwd(), "cookies.txt")
    ]
    for path in possible_paths:
        if os.path.exists(path):
            return os.path.abspath(path)
    return None

async def record_proxy_attempt(proxy: str, success: bool, speed: float = 0.0):
    try:
        database = db.get_db()
        now = datetime.utcnow()
        if success:
            await database[PROXY_CACHE].update_one(
                {"proxy": proxy},
                {
                    "$set": {"lastSuccess": now, "failures": 0},
                    "$inc": {"successRate": 1, "successCount": 1},
                    "$push": {"speeds": speed}
                },
                upsert=True
            )
            # Keep only the last 10 speeds to calculate averageSpeed
            doc = await database[PROXY_CACHE].find_one({"proxy": proxy})
            if doc and "speeds" in doc:
                speeds = doc["speeds"][-10:]
                avg_speed = sum(speeds) / len(speeds)
                await database[PROXY_CACHE].update_one(
                    {"proxy": proxy},
                    {"$set": {"speeds": speeds, "averageSpeed": avg_speed}}
                )
        else:
            await database[PROXY_CACHE].update_one(
                {"proxy": proxy},
                {
                    "$inc": {"failures": 1, "failCount": 1},
                    "$set": {"updatedAt": now}
                },
                upsert=True
            )
            doc = await database[PROXY_CACHE].find_one({"proxy": proxy})
            if doc and doc.get("failures", 0) >= 5:
                # Remove proxy after 5 consecutive failures
                await database[PROXY_CACHE].delete_one({"proxy": proxy})
    except Exception as e:
        logger.error(f"Error in record_proxy_attempt: {str(e)}")

async def get_best_proxies(limit: int = 10) -> List[str]:
    try:
        database = db.get_db()
        # Find verified working proxies sorted by successRate / speed
        cursor = database[PROXY_CACHE].find({}).sort([("successRate", -1), ("averageSpeed", -1)]).limit(limit)
        proxies = [doc["proxy"] for doc in await cursor.to_list(length=limit)]
        if len(proxies) < limit:
            # Backfill with new free proxies
            fetched = await get_free_proxies()
            random.shuffle(fetched)
            for p in fetched:
                if p not in proxies:
                    proxies.append(p)
                if len(proxies) >= limit:
                    break
        return proxies
    except Exception as e:
        logger.error(f"Error getting best proxies: {str(e)}")
        # Fallback to pure scraped list
        fetched = await get_free_proxies()
        random.shuffle(fetched)
        return fetched[:limit]

def yt_extract_sync(video_id: str, method: str, proxy: Optional[str] = None, use_cookies: bool = False) -> Dict[str, Any]:
    url = f"https://www.youtube.com/watch?v={video_id}"
    opts = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 3.0,  # connect timeout (3s)
        # We handle read timeout by wrapping the task in a wait
    }
    if proxy:
        opts["proxy"] = f"http://{proxy}"
    if use_cookies:
        cookies_path = get_cookies_path()
        if cookies_path:
            opts["cookiefile"] = cookies_path

    start_time = time.time()
    try:
        with YoutubeDL(opts) as ydl:
            # extract_info performs HTTP requests to fetch metadata & formats
            info = ydl.extract_info(url, download=False)
            duration = time.time() - start_time
            # Find the direct audio stream URL
            formats = info.get("formats", [])
            # filter for audio formats
            audio_formats = [f for f in formats if f.get("acodec") != "none" and f.get("vcodec") == "none"]
            if not audio_formats:
                audio_formats = [f for f in formats if f.get("acodec") != "none"]
            
            # Sort by quality/bitrate to get the best one
            audio_formats.sort(key=lambda x: x.get("abr") or 0, reverse=True)
            
            best_format = audio_formats[0] if audio_formats else formats[0] if formats else None
            if not best_format or not best_format.get("url"):
                raise RuntimeError("No suitable audio stream found")

            # Extract expiration from URL if present (typically &expire=xxx in YouTube URLs)
            expires_at = datetime.utcnow() + timedelta(hours=4)  # default YouTube stream URLs expire in ~6 hours, 4 hours is safe
            stream_url = best_format["url"]
            if "expire=" in stream_url:
                try:
                    import urllib.parse as urlparse
                    parsed = urlparse.urlparse(stream_url)
                    query = urlparse.parse_qs(parsed.query)
                    if "expire" in query:
                        expire_ts = int(query["expire"][0])
                        expires_at = datetime.utcfromtimestamp(expire_ts)
                except Exception:
                    pass

            return {
                "success": True,
                "method": method,
                "proxy": proxy,
                "cookiesUsed": use_cookies,
                "formatId": best_format.get("format_id", "unknown"),
                "streamUrl": stream_url,
                "expiresAt": expires_at,
                "resolveTime": duration,
                "title": info.get("title"),
                "artist": info.get("uploader") or "Various Artists",
                "thumbnail": info.get("thumbnail") or f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                "duration": info.get("duration") or 200
            }
    except Exception as e:
        return {
            "success": False,
            "method": method,
            "proxy": proxy,
            "cookiesUsed": use_cookies,
            "error": str(e),
            "resolveTime": time.time() - start_time
        }

async def run_method_with_timeout(video_id: str, method: str, proxy: Optional[str] = None, use_cookies: bool = False) -> Dict[str, Any]:
    # Timeouts: connect 3s, read 5s. Total timeout limit of 5.5s is safe.
    try:
        # Run sync extractor in a thread pool and await it with timeout
        res = await asyncio.wait_for(
            asyncio.to_thread(yt_extract_sync, video_id, method, proxy, use_cookies),
            timeout=5.5
        )
        return res
    except asyncio.TimeoutError:
        return {
            "success": False,
            "method": method,
            "proxy": proxy,
            "cookiesUsed": use_cookies,
            "error": "Timeout",
            "resolveTime": 5.5
        }

async def update_stream_cache(video_id: str, result: Dict[str, Any]):
    try:
        database = db.get_db()
        now = datetime.utcnow()
        if result["success"]:
            # Update cache with successful method
            existing = await database[STREAM_CACHE].find_one({"videoId": video_id})
            success_count = 1
            fail_count = 0
            avg_resolve_time = result["resolveTime"]
            if existing:
                success_count = existing.get("successCount", 0) + 1
                fail_count = existing.get("failCount", 0)
                # Compute moving average
                total_runs = success_count + fail_count
                avg_resolve_time = ((existing.get("averageResolveTime") or 0.0) * (total_runs - 1) + result["resolveTime"]) / total_runs

            await database[STREAM_CACHE].update_one(
                {"videoId": video_id},
                {
                    "$set": {
                        "workingMethod": result["method"],
                        "proxy": result["proxy"],
                        "cookiesUsed": result["cookiesUsed"],
                        "formatId": result["formatId"],
                        "streamUrl": result["streamUrl"],
                        "expiresAt": result["expiresAt"],
                        "averageResolveTime": avg_resolve_time,
                        "successCount": success_count,
                        "failCount": fail_count,
                        "updatedAt": now
                    }
                },
                upsert=True
            )
        else:
            # Increment failure count
            await database[STREAM_CACHE].update_one(
                {"videoId": video_id},
                {
                    "$inc": {"failCount": 1},
                    "$set": {"updatedAt": now}
                },
                upsert=True
            )
    except Exception as e:
        logger.error(f"Error updating stream cache: {str(e)}")

async def resolve_stream(video_id: str) -> Dict[str, Any]:
    database = db.get_db()
    
    # 1. Check stream_cache
    now = datetime.utcnow()
    cached = await database[STREAM_CACHE].find_one({"videoId": video_id})
    if cached and cached.get("expiresAt") and cached["expiresAt"] > now:
        # If cache contains a valid, non-expired streamUrl
        return {
            "streamUrl": cached["streamUrl"],
            "expires": cached["expiresAt"].isoformat(),
            "quality": cached.get("formatId", "bestaudio"),
            "cached": True
        }

    # 2. Get working methods ordered by priority
    method_order = list(DEFAULT_METHOD_ORDER)
    if cached and cached.get("workingMethod"):
        pref_method = cached["workingMethod"]
        if pref_method in method_order:
            method_order.remove(pref_method)
            method_order.insert(0, pref_method)

    # 3. Resolve best proxy
    best_proxies = await get_best_proxies(limit=3)
    best_proxy = best_proxies[0] if best_proxies else None

    # Helper function to construct resolution task for a method
    def get_task_for_method(m: str):
        if m == "direct":
            return run_method_with_timeout(video_id, "direct", proxy=None, use_cookies=False)
        elif m == "cookies":
            return run_method_with_timeout(video_id, "cookies", proxy=None, use_cookies=True)
        else:
            return run_method_with_timeout(video_id, "proxyPool", proxy=best_proxy, use_cookies=False)

    # 4. Try the preferred method first if it exists
    preferred_success = None
    if cached and cached.get("workingMethod"):
        pref = cached["workingMethod"]
        logger.info(f"Trying preferred method '{pref}' first for song {video_id}")
        res = await get_task_for_method(pref)
        if res["success"]:
            preferred_success = res
            # Record success (for proxy if proxy method was used)
            if pref == "proxyPool" and best_proxy:
                await record_proxy_attempt(best_proxy, success=True, speed=res["resolveTime"])
        else:
            logger.info(f"Preferred method '{pref}' failed for song {video_id}, falling back to concurrent race")
            if pref == "proxyPool" and best_proxy:
                await record_proxy_attempt(best_proxy, success=False)
            # Demote working method
            await update_stream_cache(video_id, res)

    if preferred_success:
        await update_stream_cache(video_id, preferred_success)
        return {
            "streamUrl": preferred_success["streamUrl"],
            "expires": preferred_success["expiresAt"].isoformat(),
            "quality": preferred_success["formatId"]
        }

    # 5. Concurrent resolution: race direct, bestProxy, cookies
    tasks = []
    # Only try methods that aren't the failed preferred one, or try all if no preference was set
    active_methods = [m for m in method_order if not (cached and cached.get("workingMethod") == m)]
    if not active_methods:
        active_methods = list(method_order)

    # Prepare task mapping
    task_map = {}
    for m in active_methods:
        t = get_task_for_method(m)
        tasks.append(t)
        task_map[t] = m

    # Concurrent race: first successful resolver wins.
    # Cancel remaining.
    done_tasks = []
    pending_tasks = [asyncio.create_task(t) for t in tasks]
    winning_result = None

    try:
        while pending_tasks:
            done, pending = await asyncio.wait(pending_tasks, return_when=asyncio.FIRST_COMPLETED)
            done_tasks.extend(done)
            pending_tasks = list(pending)

            for d in done:
                res = d.result()
                if res["success"]:
                    winning_result = res
                    break
            
            if winning_result:
                break
    finally:
        # Cancel all remaining tasks immediately
        for p in pending_tasks:
            p.cancel()

    if winning_result:
        # Record proxy health
        if winning_result["method"] == "proxyPool" and best_proxy:
            await record_proxy_attempt(best_proxy, success=True, speed=winning_result["resolveTime"])
        
        await update_stream_cache(video_id, winning_result)
        return {
            "streamUrl": winning_result["streamUrl"],
            "expires": winning_result["expiresAt"].isoformat(),
            "quality": winning_result["formatId"]
        }

    # If all failed, log and raise error
    # Try any remaining proxies as a desperate fallback
    if best_proxies and len(best_proxies) > 1:
        for backup_proxy in best_proxies[1:]:
            logger.info(f"Desperate fallback attempt with backup proxy {backup_proxy} for song {video_id}")
            res = await run_method_with_timeout(video_id, "proxyPool", proxy=backup_proxy, use_cookies=False)
            if res["success"]:
                await record_proxy_attempt(backup_proxy, success=True, speed=res["resolveTime"])
                await update_stream_cache(video_id, res)
                return {
                    "streamUrl": res["streamUrl"],
                    "expires": res["expiresAt"].isoformat(),
                    "quality": res["formatId"]
                }
            else:
                await record_proxy_attempt(backup_proxy, success=False)

    raise RuntimeError("All resolution attempts failed")

# Background cache warming task
async def pre_resolve_tracks(video_ids: List[str]):
    for vid in video_ids[:6]:  # pre-resolve top results (limit to top 6 to prevent server strain)
        try:
            logger.info(f"Background pre-resolving track {vid}")
            await resolve_stream(vid)
        except Exception as e:
            logger.warning(f"Failed background resolve for {vid}: {str(e)}")

# Extract MP3 for download (legacy logic preserved)
def extract_youtube_mp3(video_id: str, title_hint: str) -> tuple[str, str]:
    import tempfile
    import shutil
    from pathlib import Path as FilePath
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

    # Use cookies if available
    cookies_path = get_cookies_path()
    if cookies_path:
        base_options["cookiefile"] = cookies_path

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
    try:
        # Run event loop to get proxies
        loop = asyncio.new_event_loop()
        proxies = loop.run_until_complete(get_best_proxies(limit=10))
        loop.close()
    except Exception:
        proxies = []

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
    import shutil
    from pathlib import Path as FilePath
    shutil.rmtree(str(FilePath(path).parent), ignore_errors=True)

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
    import shutil
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
    id: str = Path(..., description="The YouTube videoId to resolve"),
    background_tasks: BackgroundTask = None
):
    try:
        id = sanitize_youtube_id(id)
        database = db.get_db()
        
        # 1. Search database to see if we already have song metadata cached
        song_doc = await database[db.PLAYLISTS].find_one(
            {"songs.videoId": id},
            {"songs.$": 1}
        )
        
        song_data = None
        if song_doc and "songs" in song_doc and len(song_doc["songs"]) > 0:
            song_data = song_doc["songs"][0]
        else:
            liked_doc = await database[db.LIKED_SONGS].find_one({"song.videoId": id})
            if liked_doc:
                song_data = liked_doc["song"]
            else:
                hist_doc = await database[db.PLAYBACK_HISTORIES].find_one({"song.videoId": id})
                if hist_doc:
                    song_data = hist_doc["song"]

        # 2. Check if we already have a resolved stream in cache
        now = datetime.utcnow()
        cached = await database[STREAM_CACHE].find_one({"videoId": id})
        
        # 3. Dynamic resolution logic
        if cached and cached.get("expiresAt") and cached["expiresAt"] > now:
            stream_url = cached["streamUrl"]
            quality = cached.get("formatId", "bestaudio")
            expires = cached["expiresAt"].isoformat()
        else:
            # Song is not resolved, trigger instant resolving fallback
            if background_tasks:
                background_tasks.add_task(resolve_stream, id)
            return {
                "success": True,
                "status": "resolving",
                "data": {
                    "videoId": id,
                    "title": song_data.get("title") if song_data else f"YouTube Track ({id})",
                    "artist": song_data.get("artist") if song_data else "Various Artists",
                    "thumbnail": song_data.get("thumbnail") if song_data else f"https://img.youtube.com/vi/{id}/hqdefault.jpg",
                    "duration": song_data.get("duration") if song_data else 240,
                    "metadata": song_data.get("metadata", {}) if song_data else {},
                    "streamUrl": f"https://www.youtube.com/watch?v={id}"
                }
            }

        if song_data:
            return {
                "success": True,
                "data": {
                    "videoId": song_data.get("videoId"),
                    "title": song_data.get("title"),
                    "artist": song_data.get("artist"),
                    "thumbnail": song_data.get("thumbnail"),
                    "duration": song_data.get("duration"),
                    "metadata": {**(song_data.get("metadata", {}) or {}), "audioUrl": stream_url, "expires": expires, "quality": quality},
                    "streamUrl": stream_url
                }
            }
        
        return {
            "success": True,
            "data": {
                "videoId": id,
                "title": f"YouTube Track ({id})",
                "artist": "Various Artists",
                "thumbnail": f"https://img.youtube.com/vi/{id}/hqdefault.jpg",
                "duration": 240,
                "metadata": {"audioUrl": stream_url, "expires": expires, "quality": quality},
                "streamUrl": stream_url
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
