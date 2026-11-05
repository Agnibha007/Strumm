import hashlib
import hmac
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import quote, urljoin, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from rapidfuzz.fuzz import ratio, token_set_ratio

from app.routes.dependencies import get_current_user
from app.services.download_quota import try_consume_song_download
from app.services.http_client import get_http_client
from app.services.security import create_pinned_client

logger = logging.getLogger("strumm-song-downloads")
router = APIRouter(prefix="/downloads", tags=["song-downloads"])

OPENVERSE_API = "https://api.openverse.org/v1"
CCMIXTER_API = "https://ccmixter.org/api/query"
EPIDEMIC_API = "https://api.epidemicsound.com/v0"
MAX_AUDIO_BYTES = 500 * 1024 * 1024
MAX_PROVIDER_RESULTS = 20
MAX_SEARCH_QUERIES = 3
MAX_API_ATTEMPTS = 2
MAX_REDIRECTS = 5
COMMERCIAL_OPENVERSE_LICENSES = {"cc0", "pdm", "by", "by-sa", "by-nd"}
CCMIXTER_LICENSE_PREFIXES = (
    "https://creativecommons.org/licenses/by/",
    "http://creativecommons.org/licenses/by/",
    "https://creativecommons.org/licenses/by-sa/",
    "http://creativecommons.org/licenses/by-sa/",
)
AUDIO_MIME_TYPES = {"audio/mpeg", "audio/mp3"}


class SongDownloadRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    artist: str = Field(..., min_length=1, max_length=120)
    duration: float = Field(0, ge=0, le=86400)


@dataclass
class DownloadSource:
    provider: str
    audio_url: str
    title: str
    artist: str
    source_url: str = ""
    license: str = ""
    license_url: str = ""
    attribution: str = ""
    track_id: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class OpenedMedia:
    response: httpx.Response
    clients: list[httpx.AsyncClient]

    async def close(self):
        try:
            await self.response.aclose()
        finally:
            for client in reversed(self.clients):
                await client.aclose()


def _normalize(value: str) -> str:
    cleaned = str(value or "").casefold().replace("&", " and ")
    cleaned = re.sub(
        r"\b(?:official\s+(?:music\s+)?(?:audio|video)|lyrics?\s+video|visualizer|\d{3,4}p|hd|4k)\b",
        " ",
        cleaned,
    )
    return re.sub(r"[^\w]+", " ", cleaned, flags=re.UNICODE).strip()


def _artist_score(requested: str, candidate: str) -> float:
    wanted = _normalize(requested)
    found = _normalize(candidate)
    if not wanted or not found:
        return 0.0
    variants = [wanted]
    variants.extend(
        _normalize(part)
        for part in re.split(r"\s*(?:,|;|\bfeat\.?\b|\bft\.?\b|\s&\s)\s*", requested, flags=re.IGNORECASE)
    )
    variants = [item for item in variants if item]
    return max((ratio(item, found) for item in variants), default=0.0)


def _title_score(requested: str, candidate: str) -> float:
    left = _normalize(requested)
    right = _normalize(candidate)
    if not left or not right:
        return 0.0
    return max(ratio(left, right), token_set_ratio(left, right))


def _match_score(title: str, artist: str, candidate_title: str, candidate_artist: str) -> Optional[float]:
    title_score = _title_score(title, candidate_title)
    artist_score = _artist_score(artist, candidate_artist)
    if title_score < 88 or artist_score < 55:
        return None
    combined = title_score * 0.78 + artist_score * 0.22
    return combined if combined >= 82 else None


def _duration_matches(requested_seconds: float, candidate_seconds: Optional[float]) -> bool:
    if candidate_seconds is None or candidate_seconds <= 0:
        return False
    if requested_seconds <= 0:
        return candidate_seconds >= 90
    tolerance = max(20.0, requested_seconds * 0.18)
    return abs(requested_seconds - candidate_seconds) <= tolerance


def _search_queries(title: str, artist: str) -> list[str]:
    cleaned = re.sub(
        r"\s*[\[(](?:official|lyrics?|visualizer|audio only|music video|hd|4k)[^\])]*[\])]?\s*$",
        "",
        title,
        flags=re.IGNORECASE,
    ).strip(" -|–")
    values = [
        " ".join(part for part in (title.strip(), artist.strip()) if part),
        title.strip(),
        " ".join(part for part in (cleaned, artist.strip()) if part),
    ]
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = _normalize(value)
        if value and normalized and normalized not in seen:
            result.append(value[:200])
            seen.add(normalized)
        if len(result) >= MAX_SEARCH_QUERIES:
            break
    return result


async def _provider_json(
    url: str,
    params: Optional[dict[str, Any]] = None,
    headers: Optional[dict[str, str]] = None,
) -> Any:
    client = get_http_client()
    for attempt in range(MAX_API_ATTEMPTS):
        try:
            response = await client.get(
                url,
                params=params,
                headers=headers,
                timeout=httpx.Timeout(18.0, connect=8.0, read=14.0),
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            if attempt + 1 < MAX_API_ATTEMPTS:
                logger.warning("Provider API timed out (%s); retrying once.", type(exc).__name__)
                continue
            raise HTTPException(status_code=503, detail="A music download source is temporarily unavailable.") from exc

        if response.status_code >= 500 and attempt + 1 < MAX_API_ATTEMPTS:
            await response.aclose()
            continue
        if response.status_code == 429:
            raise HTTPException(status_code=503, detail="A music download source is rate limiting requests.")
        if not response.is_success:
            logger.info("Provider API returned HTTP %s for %s", response.status_code, urlsplit(url).netloc)
            if response.status_code == 404:
                return None
            raise HTTPException(
                status_code=502,
                detail="A music download source could not complete the request.",
            )
        try:
            return response.json()
        except ValueError:
            text = response.text
            if text.lstrip().startswith("["):
                import json
                try:
                    return json.loads(text)
                except ValueError:
                    pass
            raise HTTPException(status_code=502, detail="A music source returned invalid search data.")
    return None


async def _find_openverse(title: str, artist: str, duration: float) -> Optional[DownloadSource]:
    for query in _search_queries(title, artist):
        payload = await _provider_json(
            OPENVERSE_API + "/audio/",
            {
                "q": query,
                "license_type": "commercial",
                "extension": "mp3",
                "filter_dead": "true",
                "page_size": MAX_PROVIDER_RESULTS,
                "mature": "false",
            },
        )
        results = payload.get("results", []) if isinstance(payload, dict) else []
        best: Optional[tuple[float, dict]] = None
        for item in results:
            if not isinstance(item, dict):
                continue
            category = str(item.get("category") or "").lower()
            if category and category != "music":
                continue
            license_code = str(item.get("license") or "").lower()
            if license_code not in COMMERCIAL_OPENVERSE_LICENSES:
                continue
            if str(item.get("filetype") or "").lower() != "mp3":
                continue
            audio_url = str(item.get("url") or "")
            if not audio_url:
                continue
            duration_seconds = item.get("duration")
            if isinstance(duration_seconds, (int, float)):
                duration_seconds = float(duration_seconds) / 1000
            else:
                duration_seconds = None
            if not _duration_matches(duration, duration_seconds):
                continue
            candidate_title = str(item.get("title") or "")
            creator = str(item.get("creator") or "")
            score = _match_score(title, artist, candidate_title, creator)
            if score is not None and (best is None or score > best[0]):
                best = (score, item)

        if best:
            item = best[1]
            attribution = str(item.get("attribution") or "").strip()
            if not attribution:
                attribution = f"{item.get('title', title)} by {item.get('creator', artist)}"
            return DownloadSource(
                provider="openverse",
                audio_url=str(item["url"]),
                title=str(item.get("title") or title)[:200],
                artist=str(item.get("creator") or artist)[:120],
                source_url=str(item.get("foreign_landing_url") or ""),
                license=str(item.get("license") or "").upper() + (
                    f" {item.get('license_version')}" if item.get("license_version") else ""
                ),
                license_url=str(item.get("license_url") or ""),
                attribution=attribution[:1000],
                track_id=str(item.get("id") or ""),
                extra={"provider": item.get("provider"), "source": item.get("source")},
            )
    return None


def _parse_ccmixter_duration(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    parts = value.strip().split(":")
    try:
        numbers = [int(part) for part in parts]
    except ValueError:
        return None
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    if len(numbers) == 3:
        return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    return None


async def _find_ccmixter(title: str, artist: str, duration: float) -> Optional[DownloadSource]:
    for query in _search_queries(title, artist):
        payload = await _provider_json(
            CCMIXTER_API,
            {
                "f": "js",
                "limit": MAX_PROVIDER_RESULTS,
                "search": query,
                "search_type": "all",
                "lic": "by",
            },
        )
        if not isinstance(payload, list):
            continue
        best: Optional[tuple[float, dict, dict]] = None
        for item in payload:
            if not isinstance(item, dict):
                continue
            license_url = str(item.get("license_url") or "").lower()
            if not license_url.startswith(CCMIXTER_LICENSE_PREFIXES):
                continue
            candidate_title = str(item.get("upload_name") or "")
            creator = str(item.get("user_name") or "")
            score = _match_score(title, artist, candidate_title, creator)
            if score is None:
                continue

            files = item.get("files") if isinstance(item.get("files"), list) else []
            for file_item in files:
                if not isinstance(file_item, dict):
                    continue
                file_extra = file_item.get("file_extra") if isinstance(file_item.get("file_extra"), dict) else {}
                file_kind = str(file_extra.get("type") or "").lower()
                file_tags = str(file_extra.get("ccud") or "").lower()
                if file_kind in {"sample", "samples", "pella", "preview", "stem", "stems"}:
                    continue
                if any(tag in file_tags.split(",") for tag in ("sample", "samples", "acappella", "pella", "preview")):
                    continue
                format_info = file_item.get("file_format_info")
                format_info = format_info if isinstance(format_info, dict) else {}
                if str(format_info.get("mime_type") or "").lower() != "audio/mpeg":
                    continue
                download_url = str(file_item.get("download_url") or "")
                if not download_url.lower().endswith(".mp3"):
                    continue
                duration_seconds = _parse_ccmixter_duration(format_info.get("ps"))
                if not _duration_matches(duration, duration_seconds):
                    continue
                if best is None or score > best[0]:
                    best = (score, item, file_item)
                break

        if best:
            item, file_item = best[1], best[2]
            return DownloadSource(
                provider="ccmixter",
                audio_url=str(file_item["download_url"]),
                title=str(item.get("upload_name") or title)[:200],
                artist=str(item.get("user_name") or artist)[:120],
                source_url=str(item.get("file_page_url") or ""),
                license=str(item.get("license_name") or "CC BY"),
                license_url=str(item.get("license_url") or ""),
                attribution=f"{item.get('upload_name', title)} by {item.get('user_name', artist)} (ccMixter)",
                track_id=str(item.get("upload_id") or ""),
                extra={"file_name": file_item.get("file_name")},
            )
    return None


def _epidemic_enabled() -> bool:
    return bool(
        os.getenv("EPIDEMIC_SOUND_API_KEY", "").strip()
        and os.getenv("EPIDEMIC_SOUND_PRODUCTION_LICENSE_CONFIRMED", "").strip().lower() == "true"
    )


def _epidemic_headers(user_id: str) -> dict[str, str]:
    api_key = os.getenv("EPIDEMIC_SOUND_API_KEY", "").strip()
    anonymized_user_id = hmac.new(
        api_key.encode("utf-8"),
        str(user_id).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "x-partner-user-id": anonymized_user_id,
    }


async def _find_epidemic(
    title: str,
    artist: str,
    duration: float,
    user_id: str,
) -> Optional[DownloadSource]:
    if not _epidemic_enabled():
        return None

    headers = _epidemic_headers(user_id)
    for query in _search_queries(title, artist):
        payload = await _provider_json(
            EPIDEMIC_API + "/tracks/search",
            {"term": query, "limit": MAX_PROVIDER_RESULTS, "sort": "Relevance", "order": "desc"},
            headers=headers,
        )
        results = payload if isinstance(payload, list) else payload.get("tracks", []) if isinstance(payload, dict) else []
        best: Optional[tuple[float, dict]] = None
        for item in results:
            if not isinstance(item, dict):
                continue
            track_id = str(item.get("id") or "")
            if not track_id:
                continue
            candidate_artist = ", ".join(
                str(value)
                for value in (item.get("mainArtists") or []) + (item.get("featuredArtists") or [])
                if value
            )
            score = _match_score(title, artist, str(item.get("title") or ""), candidate_artist)
            if score is None or not _duration_matches(duration, item.get("length")):
                continue
            if best is None or score > best[0]:
                best = (score, item)

        if best:
            item = best[1]
            track_id = str(item["id"])
            download = await _provider_json(
                f"{EPIDEMIC_API}/tracks/{quote(track_id, safe='')}/download",
                {"format": "mp3", "quality": "normal"},
                headers=headers,
            )
            audio_url = str(download.get("url") or "") if isinstance(download, dict) else ""
            if not audio_url:
                continue
            main_artists = item.get("mainArtists") or []
            artist_name = ", ".join(str(value) for value in main_artists if value) or artist
            return DownloadSource(
                provider="epidemic-sound",
                audio_url=audio_url,
                title=str(item.get("title") or title)[:200],
                artist=artist_name[:120],
                source_url=str(item.get("url") or ""),
                license="Epidemic Sound partner licence",
                attribution=f"{item.get('title', title)} by {artist_name} — Epidemic Sound",
                track_id=track_id,
                extra={"expires": download.get("expires")},
            )
    return None


async def _open_external_audio(
    url: str,
    range_header: Optional[str] = None,
    referer: Optional[str] = None,
) -> OpenedMedia:
    current_url = url
    clients: list[httpx.AsyncClient] = []
    request_headers = {"Accept": "audio/mpeg, audio/mp3;q=0.9"}
    if referer:
        referer_parts = urlsplit(referer)
        if referer_parts.scheme == "https" and referer_parts.hostname and not referer_parts.username and not referer_parts.password:
            request_headers["Referer"] = referer
    if range_header:
        if not re.fullmatch(r"bytes=(\d*)-(\d*)", range_header):
            raise HTTPException(status_code=400, detail="Invalid byte range.")
        request_headers["Range"] = range_header

    try:
        for redirect_index in range(MAX_REDIRECTS + 1):
            parsed = urlsplit(current_url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.port not in (None, 443)
            ):
                raise HTTPException(status_code=502, detail="Music provider returned an unsupported audio URL.")

            try:
                client = create_pinned_client(
                    current_url,
                    timeout=httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0),
                )
            except (ValueError, OSError) as exc:
                raise HTTPException(status_code=502, detail="Music provider returned an unsafe audio host.") from exc
            clients.append(client)
            request = client.build_request("GET", current_url, headers=request_headers)
            response = await client.send(request, stream=True, follow_redirects=False)

            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                await response.aclose()
                await client.aclose()
                clients.pop()
                if not location or redirect_index >= MAX_REDIRECTS:
                    raise HTTPException(status_code=502, detail="Music provider returned an invalid audio redirect.")
                current_url = urljoin(current_url, location)
                continue

            if response.status_code not in (200, 206):
                status_code = response.status_code
                await response.aclose()
                if status_code in (401, 403):
                    raise HTTPException(status_code=403, detail="The music provider denied access to this track.")
                if status_code == 404:
                    raise HTTPException(status_code=404, detail="The provider's audio file is no longer available.")
                if status_code == 429 or status_code >= 500:
                    raise HTTPException(status_code=503, detail="The music provider's audio server is temporarily unavailable.")
                raise HTTPException(status_code=502, detail="The music provider could not deliver the audio file.")

            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if content_type not in AUDIO_MIME_TYPES:
                await response.aclose()
                raise HTTPException(status_code=502, detail="The matched source did not return an MP3 file.")
            content_length = response.headers.get("content-length")
            if content_length and content_length.isdigit() and int(content_length) > MAX_AUDIO_BYTES:
                await response.aclose()
                raise HTTPException(status_code=413, detail="This track exceeds the 500 MiB offline download limit.")
            return OpenedMedia(response=response, clients=clients)

        raise HTTPException(status_code=502, detail="The music provider exceeded the redirect limit.")
    except Exception:
        for client in reversed(clients):
            await client.aclose()
        raise


async def _report_epidemic_download(source: DownloadSource, user_id: str):
    if source.provider != "epidemic-sound" or not source.track_id or not _epidemic_enabled():
        return
    headers = _epidemic_headers(user_id)
    payload = {
        "events": [
            {
                "userId": headers["x-partner-user-id"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "userConnected": False,
                "analyticsEvent": {
                    "trackId": source.track_id,
                    "format": "mp3",
                    "quality": "normal",
                    "type": "trackDownloaded",
                },
            }
        ]
    }
    try:
        client = get_http_client()
        response = await client.post(
            EPIDEMIC_API + "/analytics/report",
            json=payload,
            headers=headers,
            timeout=httpx.Timeout(10.0, connect=5.0),
        )
        if not response.is_success:
            logger.warning("Epidemic Sound download report returned HTTP %s.", response.status_code)
    except httpx.HTTPError as exc:
        logger.warning("Epidemic Sound download reporting failed: %s", type(exc).__name__)


def _safe_filename(title: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._ -]+", "-", title).strip(" .-_")
    value = re.sub(r"\s+", "-", value)[:100]
    return (value or "strumm-track") + ".mp3"


def _stream_response(
    opened: OpenedMedia,
    source: DownloadSource,
    user_id: str,
):
    upstream = opened.response
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Download-Provider": source.provider,
        "Content-Disposition": f'attachment; filename="{_safe_filename(source.title)}"',
    }
    header_values = {
        "X-Download-Source-Url": source.source_url,
        "X-Download-License": source.license,
        "X-Download-License-Url": source.license_url,
        "X-Download-Attribution": source.attribution,
        "X-Download-Creator": source.artist,
        "X-Download-Track-Id": source.track_id,
    }
    for name, value in header_values.items():
        if value:
            headers[name] = quote(str(value), safe=":/?&=#%+@,.-_")

    content_length = upstream.headers.get("content-length")
    if content_length and content_length.isdigit():
        headers["Content-Length"] = content_length
    content_range = upstream.headers.get("content-range")
    if content_range:
        headers["Content-Range"] = content_range
    accept_ranges = upstream.headers.get("accept-ranges")
    if accept_ranges:
        headers["Accept-Ranges"] = accept_ranges
    elif upstream.status_code == 206:
        headers["Accept-Ranges"] = "bytes"

    async def stream_bytes():
        total = 0
        completed = False
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_AUDIO_BYTES:
                    raise RuntimeError("Provider audio exceeded the 500 MiB limit.")
                yield chunk
            completed = total > 0
        finally:
            await opened.close()
            if completed:
                await _report_epidemic_download(source, user_id)

    return StreamingResponse(
        stream_bytes(),
        status_code=upstream.status_code,
        media_type="audio/mpeg",
        headers=headers,
    )


@router.post("/song")
async def download_song_from_sources(
    payload: SongDownloadRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    title = " ".join(payload.title.split())
    artist = " ".join(payload.artist.split())
    if not title or not artist:
        raise HTTPException(status_code=400, detail="A song title and artist are required.")

    user_id = str(current_user["id"])
    provider_errors: list[str] = []
    source: Optional[DownloadSource] = None
    opened: Optional[OpenedMedia] = None

    providers = (
        ("openverse", lambda: _find_openverse(title, artist, payload.duration)),
        ("ccmixter", lambda: _find_ccmixter(title, artist, payload.duration)),
        ("epidemic-sound", lambda: _find_epidemic(title, artist, payload.duration, user_id)),
    )
    for provider_name, search in providers:
        try:
            candidate = await search()
        except HTTPException as exc:
            if exc.status_code in (502, 503):
                provider_errors.append(provider_name)
                logger.warning("%s search unavailable; continuing to the next source.", provider_name)
                continue
            raise
        except Exception as exc:
            provider_errors.append(provider_name)
            logger.exception("%s download search failed: %s", provider_name, type(exc).__name__)
            continue

        if not candidate:
            continue

        try:
            candidate_opened = await _open_external_audio(
                candidate.audio_url,
                request.headers.get("range"),
                candidate.source_url,
            )
        except HTTPException as exc:
            if exc.status_code in (502, 503):
                provider_errors.append(provider_name)
            logger.warning(
                "%s matched a candidate but could not deliver its MP3 (HTTP %s); trying the next source.",
                provider_name,
                exc.status_code,
            )
            continue
        source = candidate
        opened = candidate_opened
        break

    if source is None:
        try:
            from app.routes.audius import _find_downloadable_match, _open_audius_media, _track_permalink

            track = await _find_downloadable_match(title, artist)
            if track:
                track_id = str(track.get("id") or "")
                opened_response = await _open_audius_media(
                    "/tracks/" + quote(track_id, safe="") + "/download",
                    {"original": "false"},
                    request.headers.get("range"),
                )
                user = track.get("user") if isinstance(track.get("user"), dict) else {}
                source = DownloadSource(
                    provider="audius",
                    audio_url="",
                    title=str(track.get("title") or title),
                    artist=str(user.get("name") or artist),
                    source_url=_track_permalink(track),
                    license=str(track.get("license") or ""),
                    attribution=str(track.get("copyright_line") or ""),
                    track_id=track_id,
                    extra={"track": track},
                )
                opened = OpenedMedia(response=opened_response, clients=[])
        except HTTPException as exc:
            if exc.status_code in (502, 503):
                provider_errors.append("audius")
            elif exc.status_code != 404:
                raise

    if source is None or opened is None:
        if provider_errors:
            raise HTTPException(
                status_code=503,
                detail="Music download sources are temporarily unavailable. Please retry.",
            )
        raise HTTPException(
            status_code=404,
            detail="No confidently matching track with a verified public download licence was found.",
        )

    try:
        quota_allowed = await try_consume_song_download(user_id)
    except Exception as exc:
        await opened.close()
        logger.exception("Song download quota check failed for user %s.", user_id)
        raise HTTPException(status_code=503, detail="Download service is temporarily unavailable.") from exc
    if not quota_allowed:
        await opened.close()
        raise HTTPException(status_code=429, detail="Daily song download limit reached. Please try again tomorrow.")

    return _stream_response(opened, source, user_id)
