import asyncio
import logging
import re
from typing import Any, Optional
from urllib.parse import quote, urljoin, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse

from app.services.http_client import get_http_client

logger = logging.getLogger("strumm-audius")
router = APIRouter(prefix="/audius", tags=["audius"])


AUDIUS_API_BASE = "https://api.audius.co/v1"
AUDIUS_APP_NAME = "strumm"
MAX_AUDIO_BYTES = 500 * 1024 * 1024
SEARCH_UPSTREAM_PAGE_SIZE = 100
MAX_SEARCH_PAGES = 6
SEARCH_PAGE_CONCURRENCY = 2
MAX_MEDIA_ATTEMPTS = 2
MAX_API_ATTEMPTS = 2
TRACK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
AUDIO_HOST_SUFFIXES = (
    "audius.co",
    "figment.io",
    "open-audio-validator.com",
    "audiusindex.org",
    "monophonic.digital",
    "r2.cloudflarestorage.com",
)


def _valid_track_id(track_id: str) -> str:
    cleaned = track_id.strip()
    if not TRACK_ID_PATTERN.fullmatch(cleaned):
        raise HTTPException(status_code=400, detail="Invalid Audius track ID.")
    return cleaned


def _allowed_audio_url(value: str) -> bool:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    try:
        if parsed.port not in (None, 443):
            return False
    except ValueError:
        return False
    host = parsed.hostname.lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in AUDIO_HOST_SUFFIXES)


async def _audius_json(path: str, params: Optional[dict[str, Any]] = None) -> Any:
    client = get_http_client()
    query = {"app_name": AUDIUS_APP_NAME}
    if params:
        query.update(params)

    for attempt in range(MAX_API_ATTEMPTS):
        try:
            response = await client.get(
                AUDIUS_API_BASE + path,
                params=query,
                timeout=httpx.Timeout(15.0, connect=8.0, read=12.0),
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            if attempt + 1 < MAX_API_ATTEMPTS:
                logger.warning("Audius API request failed for %s (%s); retrying once.", path, type(exc).__name__)
                await asyncio.sleep(0.25)
                continue
            logger.warning("Audius API request failed for %s after retry: %s", path, type(exc).__name__)
            raise HTTPException(status_code=503, detail="Audius is temporarily unavailable. Try again shortly.") from exc

        if response.status_code == 404:
            return None
        if response.status_code == 429:
            raise HTTPException(status_code=503, detail="Audius is rate limiting requests. Try again shortly.")
        if response.status_code >= 500 and attempt + 1 < MAX_API_ATTEMPTS:
            logger.warning("Audius API returned HTTP %s for %s; retrying once.", response.status_code, path)
            await response.aclose()
            await asyncio.sleep(0.25)
            continue
        if not response.is_success:
            logger.warning("Audius API returned HTTP %s for %s", response.status_code, path)
            raise HTTPException(status_code=502, detail="Audius could not complete the request.")

        try:
            payload = response.json()
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="Audius returned an invalid response.") from exc
        return payload.get("data") if isinstance(payload, dict) else None

    raise HTTPException(status_code=503, detail="Audius is temporarily unavailable. Try again shortly.")

async def _get_track(track_id: str) -> Optional[dict]:
    result = await _audius_json("/tracks/" + quote(track_id, safe=""))
    return result if isinstance(result, dict) else None


def _stream_allowed(track: dict) -> bool:
    return (
        track.get("is_streamable") is True
        and track.get("is_stream_gated") is not True
        and not track.get("stream_conditions")
    )


def _artwork_url(track: dict) -> str:
    artwork = track.get("artwork")
    if isinstance(artwork, dict):
        for key in ("_480x480", "_1000x1000", "_150x150"):
            value = artwork.get(key)
            if isinstance(value, str) and value.startswith("https://"):
                return value
    if isinstance(artwork, str) and artwork.startswith("https://"):
        return artwork
    cover_art = track.get("cover_art")
    if isinstance(cover_art, str) and cover_art.startswith("https://"):
        return cover_art
    return ""


def _track_permalink(track: dict) -> str:
    permalink = track.get("permalink")
    if not isinstance(permalink, str) or not permalink:
        return ""
    if permalink.startswith("/"):
        return "https://audius.co" + permalink
    if permalink.startswith("https://audius.co/"):
        return permalink
    return ""


def _normalize_track(track: dict) -> Optional[dict]:
    track_id = str(track.get("id") or "")
    if (
        not TRACK_ID_PATTERN.fullmatch(track_id)
        or track.get("is_available") is False
        or track.get("is_delete") is True
        or track.get("is_unlisted") is True
        or not _stream_allowed(track)
    ):
        return None

    user = track.get("user") if isinstance(track.get("user"), dict) else {}
    artist = user.get("name") or user.get("handle") or "Unknown Artist"
    duration = track.get("duration")
    if not isinstance(duration, (int, float)) or duration < 0:
        duration = 0

    return {
        "videoId": "audius-" + track_id,
        "title": str(track.get("title") or "Untitled track")[:200],
        "artist": str(artist)[:120],
        "thumbnail": _artwork_url(track),
        "duration": int(duration),
        "metadata": {
            "provider": "audius",
            "audiusTrackId": track_id,
            "audiusPermalink": _track_permalink(track),
            "audioUrl": "/audius/tracks/" + quote(track_id, safe="") + "/stream" if _stream_allowed(track) else None,
            "license": str(track.get("license") or ""),
            "copyrightLine": str(track.get("copyright_line") or ""),
            "producerCopyrightLine": str(track.get("producer_copyright_line") or ""),
            "streamable": True,
        },
    }


@router.get("/tracks/search")
async def search_streamable_tracks(
    q: str = Query(..., min_length=1, max_length=120),
    limit: int = Query(24, ge=1, le=50),
    offset: int = Query(0, ge=0, le=1000),
):
    query = " ".join(q.split())
    if not query:
        raise HTTPException(status_code=400, detail="A search query is required.")

    tracks = []
    seen_track_ids = set()

    # Filter every page by public streaming permissions before returning tracks.
    for batch_start in range(0, MAX_SEARCH_PAGES, SEARCH_PAGE_CONCURRENCY):
        offsets = [
            offset + page_index * SEARCH_UPSTREAM_PAGE_SIZE
            for page_index in range(
                batch_start,
                min(batch_start + SEARCH_PAGE_CONCURRENCY, MAX_SEARCH_PAGES),
            )
        ]
        page_results = await asyncio.gather(*(
            _audius_json(
                "/tracks/search",
                {
                    "query": query,
                    "limit": SEARCH_UPSTREAM_PAGE_SIZE,
                    "offset": page_offset,
                },
            )
            for page_offset in offsets
        ))

        found_any_raw_tracks = False
        for result in page_results:
            raw_tracks = result if isinstance(result, list) else []
            found_any_raw_tracks = found_any_raw_tracks or bool(raw_tracks)
            for raw in raw_tracks:
                if not isinstance(raw, dict):
                    continue
                normalized = _normalize_track(raw)
                if not normalized:
                    continue
                track_id = normalized["metadata"]["audiusTrackId"]
                if track_id in seen_track_ids:
                    continue
                seen_track_ids.add(track_id)
                tracks.append(normalized)
                if len(tracks) >= limit:
                    break
            if len(tracks) >= limit:
                break

        if len(tracks) >= limit or not found_any_raw_tracks:
            break

    return {"success": True, "data": tracks[:limit], "count": len(tracks)}


async def _open_audius_media(path: str, params: Optional[dict[str, str]] = None, range_header: Optional[str] = None):
    client = get_http_client()
    base_url = AUDIUS_API_BASE + path
    base_params = {"app_name": AUDIUS_APP_NAME}
    if params:
        base_params.update(params)
    headers = {"Accept": "audio/mpeg, audio/*;q=0.9, application/octet-stream;q=0.5"}
    if range_header:
        match = RANGE_PATTERN.fullmatch(range_header)
        if not match or not (match.group(1) or match.group(2)):
            raise HTTPException(status_code=400, detail="Invalid byte range.")
        if match.group(1) and match.group(2) and int(match.group(1)) > int(match.group(2)):
            raise HTTPException(status_code=400, detail="Invalid byte range.")
        headers["Range"] = range_header

    for attempt in range(MAX_MEDIA_ATTEMPTS):
        current_url = base_url
        current_params = dict(base_params)
        retry_attempt = False

        try:
            for redirect_count in range(4):
                if not _allowed_audio_url(current_url):
                    raise HTTPException(status_code=502, detail="Audius returned an unsupported media host.")
                request = client.build_request(
                    "GET",
                    current_url,
                    params=current_params,
                    headers=headers,
                    timeout=httpx.Timeout(90.0, connect=10.0, read=60.0),
                )
                response = await client.send(request, stream=True, follow_redirects=False)
                current_params = None
                if response.status_code in REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    await response.aclose()
                    if not location or redirect_count == 3:
                        raise HTTPException(status_code=502, detail="Audius returned an invalid media redirect.")
                    next_url = urljoin(current_url, location)
                    if not _allowed_audio_url(next_url):
                        raise HTTPException(status_code=502, detail="Audius redirected to an unsupported media host.")
                    current_url = next_url
                    continue
                if response.status_code not in (200, 206):
                    status = response.status_code
                    await response.aclose()
                    if status in (401, 403):
                        raise HTTPException(status_code=403, detail="Audius does not allow this track to be streamed.")
                    if status == 404:
                        raise HTTPException(status_code=404, detail="This Audius track is no longer available.")
                    if status == 429:
                        raise HTTPException(status_code=503, detail="Audius is rate limiting audio requests. Try again shortly.")
                    if status >= 500 and attempt + 1 < MAX_MEDIA_ATTEMPTS:
                        logger.warning("Audius media node returned HTTP %s; retrying through discovery.", status)
                        retry_attempt = True
                        break
                    raise HTTPException(status_code=502, detail="Audius could not deliver this audio stream.")
                content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if content_type not in ("audio/mpeg", "audio/mp3"):
                    await response.aclose()
                    raise HTTPException(status_code=502, detail="Audius did not return an MP3 audio file.")
                content_length = response.headers.get("content-length")
                if content_length and content_length.isdigit() and int(content_length) > MAX_AUDIO_BYTES:
                    await response.aclose()
                    raise HTTPException(status_code=413, detail="This track exceeds the 500 MiB stream limit.")
                return response

            if retry_attempt:
                await asyncio.sleep(0.25)
                continue
            raise HTTPException(status_code=502, detail="Audius exceeded the media redirect limit.")
        except HTTPException:
            raise
        except httpx.HTTPError as exc:
            logger.warning("Audius media request failed on attempt %s: %s", attempt + 1, type(exc).__name__)
            if attempt + 1 < MAX_MEDIA_ATTEMPTS:
                await asyncio.sleep(0.25)
                continue
            raise HTTPException(status_code=503, detail="Audius audio is temporarily unavailable.") from exc

    raise HTTPException(status_code=502, detail="Audius could not deliver this audio file after retrying.")



def _media_response(response: httpx.Response):
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    content_length = response.headers.get("content-length")
    if content_length and content_length.isdigit():
        headers["Content-Length"] = content_length
    content_range = response.headers.get("content-range")
    if content_range:
        headers["Content-Range"] = content_range
    accept_ranges = response.headers.get("accept-ranges")
    if accept_ranges:
        headers["Accept-Ranges"] = accept_ranges
    elif response.status_code == 206:
        headers["Accept-Ranges"] = "bytes"

    async def stream_bytes():
        total = 0
        try:
            async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_AUDIO_BYTES:
                    raise RuntimeError("Audius audio exceeded the stream size limit.")
                yield chunk
        finally:
            await response.aclose()

    return StreamingResponse(
        stream_bytes(),
        status_code=response.status_code,
        media_type="audio/mpeg",
        headers=headers,
    )


@router.get("/tracks/{track_id}/stream")
async def stream_audius_track(
    request: Request,
    track_id: str = Path(..., max_length=64),
):
    cleaned_id = _valid_track_id(track_id)
    track = await _get_track(cleaned_id)
    if not track:
        raise HTTPException(status_code=404, detail="Audius track not found.")
    if not _stream_allowed(track):
        raise HTTPException(status_code=403, detail="This Audius track is not publicly streamable.")
    response = await _open_audius_media(
        "/tracks/" + quote(cleaned_id, safe="") + "/stream",
        {"app_name": AUDIUS_APP_NAME},
        request.headers.get("range"),
    )
    return _media_response(response)
