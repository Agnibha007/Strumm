import feedparser
import httpx
import os
import re
from urllib.parse import quote, urljoin, urlparse
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body, Request
from fastapi.responses import StreamingResponse
from typing import Optional, List, Dict, Any
from bson import ObjectId
from datetime import datetime
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.podcast_index import (
    PodcastIndexNotConfigured,
    get_episodes as get_podcast_index_episodes,
    get_podcast as get_podcast_index_show,
    recent_podcasts,
    search_podcasts,
    trending_podcasts,
)
from app.services.security import assert_public_http_url, create_pinned_client, parse_object_id, sanitize_text
from httpx import Timeout as HttpxTimeout
from pydantic import BaseModel, Field, HttpUrl
import logging

logger = logging.getLogger("strumm-podcast")
router = APIRouter(prefix="/podcasts", tags=["podcast"])

class ImportRSSRequest(BaseModel):
    rss_url: str


class PodcastProgressRequest(BaseModel):
    positionSeconds: float = Field(ge=0, default=0)
    durationSeconds: float = Field(ge=0, default=0)
@router.post("/import-rss")
async def import_podcast_rss(
    payload: ImportRSSRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        rss_url_str = payload.rss_url.strip()
        if not rss_url_str.startswith("http://") and not rss_url_str.startswith("https://"):
            rss_url_str = "https://" + rss_url_str
            
        url = assert_public_http_url(rss_url_str)
        database = db.get_db()
        
        # Check if already imported
        existing = await database[db.PODCAST_SHOWS].find_one({"rss": url})
        if existing:
            existing["id"] = str(existing["_id"])
            del existing["_id"]
            return {"success": True, "data": existing, "message": "Podcast show already imported."}
            
        # Parse RSS Feed asynchronously via a DNS-pinned client (SSRF-safe)
        from app.services.security import create_pinned_client
        client = create_pinned_client(url, timeout=HttpxTimeout(connect=5.0, read=12.0, write=5.0, pool=5.0))
        try:
            resp = await client.get(url)
        finally:
            await client.aclose()
        if resp.status_code != 200:
            return {"success": False, "error": f"Failed to download RSS feed. Status code: {resp.status_code}"}
        xml_text = resp.text
            
        # Parse feed data
        feed_data = feedparser.parse(xml_text)
        if feed_data.get("bozo", 0) == 1 and not feed_data.entries:
            return {"success": False, "error": "Invalid RSS feed format."}
            
        feed_info = feed_data.feed
        title = sanitize_text(feed_info.get("title", "Untitled Podcast"), max_length=200)
        author = sanitize_text(feed_info.get("author", feed_info.get("publisher", "Unknown Author")), max_length=160)
        description = sanitize_text(feed_info.get("description", feed_info.get("summary", "")), max_length=3000)
        
        image_url = ""
        if "image" in feed_info:
            image_url = feed_info.image.get("href", "")
        elif "itunes_image" in feed_info:
            image_url = feed_info.itunes_image.get("href", "")
            
        categories = []
        if "tags" in feed_info:
            categories = [t.get("term", "") for t in feed_info.tags if t.get("term")]
            
        # Create Show document
        show_doc = {
            "title": title,
            "author": author,
            "description": description,
            "image": image_url,
            "rss": url,
            "categories": categories[:5]
        }
        
        res = await database[db.PODCAST_SHOWS].insert_one(show_doc)
        show_id = str(res.inserted_id)
        show_doc["id"] = show_id
        del show_doc["_id"]
        
        # Save first 15 episodes to database
        episodes_to_insert = []
        for entry in feed_data.entries[:15]:
            audio_url = ""
            duration = 0
            
            # Find enclosure
            audio_url = ""
            audio_mime_type = ""
            video_url = ""
            video_available = False
            media_type = "audio"
            audio_variants = {}
            
            if "enclosures" in entry:
                for enc in entry.enclosures:
                    enc_type = enc.get("type", "")
                    enc_url = enc.get("href", "")
                    if enc_type.startswith("audio/"):
                        if not audio_mime_type:
                            audio_url = enc_url
                            audio_mime_type = enc_type
                        if enc_url:
                            bitrate = str(enc.get("bitrate") or enc.get("bit_rate") or "")
                            variant_key = "high"
                            if bitrate.isdigit():
                                parsed_bitrate = int(bitrate)
                                if parsed_bitrate <= 80:
                                    variant_key = "data-saver"
                                elif parsed_bitrate <= 160:
                                    variant_key = "balanced"
                            audio_variants[variant_key] = enc_url
                    elif enc_type.startswith("video/"):
                        video_url = enc_url
                        video_available = True
                        media_type = "video"
                        if not audio_url:
                            audio_url = video_url # fallback for audio players
                        
            if not audio_url:
                continue
            audio_variants.setdefault("high", audio_url)
                
            # Parse duration
            itunes_dur = entry.get("itunes_duration", "")
            if itunes_dur:
                # Can be in seconds, HH:MM:SS or MM:SS
                if ":" in str(itunes_dur):
                    parts = str(itunes_dur).split(":")
                    if len(parts) == 2:
                        duration = int(parts[0]) * 60 + int(parts[1])
                    elif len(parts) == 3:
                        duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                else:
                    try:
                        duration = int(itunes_dur)
                    except ValueError:
                        duration = 1800
            else:
                duration = 1800 # 30 min placeholder
                
            ep_doc = {
                "showId": show_id,
                "title": sanitize_text(entry.get("title", "Untitled Episode"), max_length=240),
                "audioUrl": audio_url,
                "mimeType": audio_mime_type,
                "audioVariants": audio_variants,
                "duration": duration,
                "description": sanitize_text(entry.get("description", entry.get("summary", "")), max_length=5000),
                "publishedAt": datetime.utcnow(), # fallback
                "videoAvailable": video_available,
                "videoUrl": video_url if video_url else None,
                "mediaType": media_type
            }
            episodes_to_insert.append(ep_doc)
            
        if episodes_to_insert:
            await database[db.PODCAST_EPISODES].insert_many(episodes_to_insert)

        return {
            "success": True,
            "data": {
                "show": show_doc,
                "episodes_count": len(episodes_to_insert)
            }
        }
    except Exception as e:
        logger.error(f"Error importing podcast RSS: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}

@router.get("/shows")
async def get_shows(
    category: Optional[str] = Query(None),
    query: Optional[str] = Query(None, min_length=1),
    limit: int = Query(24, ge=1, le=40)
):
    try:
        cleaned_query = sanitize_text(query, max_length=120) if query else None
        if cleaned_query:
            shows = await search_podcasts(cleaned_query, max_results=limit)
            return {"success": True, "data": shows}

        try:
            shows = await trending_podcasts(max_results=limit)
        except Exception:
            shows = await recent_podcasts(max_results=limit)

        if shows:
            return {"success": True, "data": shows}
    except PodcastIndexNotConfigured:
        logger.warning("PodcastIndex credentials are not configured; falling back to local podcast catalog.")
    except Exception as e:
        logger.error(f"PodcastIndex catalog failed; falling back to local catalog: {str(e)}")

    try:
        database = db.get_db()
        query = {}
        if category:
            query["categories"] = {"$in": [sanitize_text(category, max_length=80)]}
            
        cursor = database[db.PODCAST_SHOWS].find(query).limit(limit)
        shows = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
            shows.append(doc)
            
        return {"success": True, "data": shows}
    except Exception as e:
        logger.error(f"Error fetching shows: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}

@router.get("/shows/{id}")
async def get_show_details(id: str = Path(...)):
    try:
        cleaned_id = sanitize_text(id, max_length=32)
        if cleaned_id.isdigit():
            from app.services.cache import get_cached_podcast, cache_podcast
            cache_key_str = f"podcast-details:{cleaned_id}"
            cached = get_cached_podcast(cache_key_str)
            if cached:
                return {"success": True, "data": cached}

            show = await get_podcast_index_show(cleaned_id)
            if not show:
                return {"success": False, "error": "Show not found"}
            episodes = await get_podcast_index_episodes(cleaned_id, max_results=1000)
            res_data = {
                "show": show,
                "episodes": episodes
            }
            cache_podcast(cache_key_str, res_data)
            return {
                "success": True,
                "data": res_data
            }
    except PodcastIndexNotConfigured:
        logger.warning("PodcastIndex credentials are not configured; falling back to local show lookup.")
    except Exception as e:
        logger.error(f"PodcastIndex show lookup failed; falling back to local lookup: {str(e)}")

    try:
        from app.services.cache import get_cached_podcast, cache_podcast
        cache_key_str = f"podcast-details:{id}"
        cached = get_cached_podcast(cache_key_str)
        if cached:
            return {"success": True, "data": cached}

        database = db.get_db()
        show = await database[db.PODCAST_SHOWS].find_one({"_id": parse_object_id(id)})
        if not show:
            return {"success": False, "error": "Show not found"}
            
        show["id"] = str(show["_id"])
        del show["_id"]
        
        # Get episodes
        ep_cursor = database[db.PODCAST_EPISODES].find({"showId": id}).sort("publishedAt", -1)
        episodes = []
        async for ep in ep_cursor:
            ep["id"] = str(ep["_id"])
            del ep["_id"]
            ep["videoAvailable"] = ep.get("videoAvailable", False)
            ep["videoUrl"] = ep.get("videoUrl", None)
            ep["mediaType"] = ep.get("mediaType", "audio")
            ep["audioVariants"] = ep.get("audioVariants", {"high": ep.get("audioUrl", "")})
            episodes.append(ep)
            
        res_data = {
            "show": show,
            "episodes": episodes
        }
        cache_podcast(cache_key_str, res_data)
        return {
            "success": True,
            "data": res_data
        }
    except Exception as e:
        logger.error(f"Error fetching show details: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}

@router.post("/shows/{id}/follow")
async def follow_show(
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        content_id = sanitize_text(id, max_length=64)
        userId = current_user["id"]
        
        # Check if already following
        existing = await database["follows"].find_one({
            "userId": userId,
            "contentType": "podcast",
            "contentId": content_id
        })
        
        if existing:
            await database["follows"].delete_one({"_id": existing["_id"]})
            return {"success": True, "data": {"following": False, "message": "Unfollowed podcast show."}}
        else:
            await database["follows"].insert_one({
                "userId": userId,
                "contentType": "podcast",
                "contentId": content_id,
                "followedAt": datetime.utcnow()
            })
            return {"success": True, "data": {"following": True, "message": "Followed podcast show."}}
    except Exception as e:
        logger.error(f"Error following podcast: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


@router.get("/episode/{id}")
async def get_episode_details(id: str = Path(...)):
    try:
        cleaned_id = sanitize_text(id, max_length=64)
        
        # 1. If ID is numeric, query PodcastIndex first
        if cleaned_id.isdigit():
            from app.services.podcast_index import get_episode_by_id as get_idx_episode
            try:
                ep = await get_idx_episode(cleaned_id)
                if ep:
                    show = await get_podcast_index_show(ep["showId"])
                    return {
                        "success": True,
                        "data": {
                            "episode": ep,
                            "show": show
                        }
                    }
            except Exception as index_err:
                logger.error(f"PodcastIndex episode fetch error: {index_err}")
                
        # 2. Query database for local shows/episodes
        database = db.get_db()
        ep = await database[db.PODCAST_EPISODES].find_one({"_id": parse_object_id(id)})
        if ep:
            ep["id"] = str(ep["_id"])
            del ep["_id"]
            ep["videoAvailable"] = ep.get("videoAvailable", False)
            ep["videoUrl"] = ep.get("videoUrl", None)
            ep["mediaType"] = ep.get("mediaType", "audio")
            ep["audioVariants"] = ep.get("audioVariants", {"high": ep.get("audioUrl", "")})
            
            show = await database[db.PODCAST_SHOWS].find_one({"_id": parse_object_id(ep["showId"])})
            if show:
                show["id"] = str(show["_id"])
                del show["_id"]
                
            return {
                "success": True,
                "data": {
                    "episode": ep,
                    "show": show
                }
            }
            
        return {"success": False, "error": "Episode not found"}
    except Exception as e:
        logger.error(f"Error fetching episode details: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}



PODCAST_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024
PODCAST_DOWNLOAD_MAX_REDIRECTS = 4
PODCAST_AUDIO_EXTENSIONS = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".weba": "audio/webm",
    ".webm": "audio/webm",
}


def _podcast_audio_mime(upstream_type: str, source_url: str, declared_type: str = "") -> str:
    actual = (upstream_type or "").split(";", 1)[0].strip().lower()
    declared = (declared_type or "").split(";", 1)[0].strip().lower()
    if actual.startswith("audio/"):
        return actual
    if actual in {"text/html", "application/xhtml+xml", "text/plain"}:
        raise HTTPException(status_code=415, detail="The podcast source did not return an audio file.")
    extension = os.path.splitext(urlparse(source_url).path)[1].lower()
    inferred = PODCAST_AUDIO_EXTENSIONS.get(extension)
    if actual in {"", "application/octet-stream", "binary/octet-stream"}:
        if declared.startswith("audio/"):
            return declared
        if inferred:
            return inferred
    if actual == "application/ogg" and extension in {".ogg", ".opus", ".oga"}:
        return "audio/ogg"
    raise HTTPException(status_code=415, detail="This episode's media format is not supported for downloads.")


def _podcast_download_filename(title: str, mime_type: str) -> tuple[str, str]:
    clean_title = re.sub(r"[\x00-\x1f\x7f]", "", str(title or "Podcast episode"))
    clean_title = re.sub(r'[<>:"/\\|?*]', "", clean_title).strip(" .")[:120]
    if not clean_title:
        clean_title = "Podcast episode"
    extension_by_mime = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".m4a",
        "audio/aac": ".aac",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/flac": ".flac",
        "audio/webm": ".webm",
    }
    extension = extension_by_mime.get(mime_type, ".audio")
    ascii_title = clean_title.encode("ascii", "ignore").decode("ascii")
    ascii_title = re.sub(r"[^A-Za-z0-9._ -]", "", ascii_title).strip(" .")[:100] or "podcast-episode"
    ascii_name = f"{ascii_title}{extension}"
    encoded_name = quote(f"{clean_title}{extension}", safe="")
    return ascii_name, encoded_name


async def _resolve_podcast_episode_for_download(episode_id: str) -> dict:
    cleaned_id = sanitize_text(episode_id, max_length=64)
    if not cleaned_id:
        raise HTTPException(status_code=400, detail="Invalid episode identifier.")

    if cleaned_id.isdigit():
        try:
            from app.services.podcast_index import get_episode_by_id as get_index_episode
            episode = await get_index_episode(cleaned_id)
            if episode:
                show = None
                try:
                    show = await get_podcast_index_show(str(episode.get("showId") or ""))
                except Exception:
                    show = None
                episode["showTitle"] = (show or {}).get("title") or "Podcast"
                episode["mimeType"] = episode.get("mimeType") or episode.get("enclosureType") or ""
                episode["videoUrl"] = episode.get("videoUrl") or ""
                return episode
        except PodcastIndexNotConfigured:
            pass
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("PodcastIndex download resolution failed for episode %s: %s", cleaned_id, type(exc).__name__)
        raise HTTPException(status_code=404, detail="Podcast episode was not found.")

    try:
        object_id = parse_object_id(cleaned_id)
    except HTTPException:
        raise HTTPException(status_code=404, detail="Podcast episode was not found.")

    database = db.get_db()
    episode = await database[db.PODCAST_EPISODES].find_one({"_id": object_id})
    if not episode:
        raise HTTPException(status_code=404, detail="Podcast episode was not found.")

    show_id = str(episode.get("showId") or "")
    show = None
    if show_id:
        try:
            show_object_id = parse_object_id(show_id)
            show = await database[db.PODCAST_SHOWS].find_one({"_id": show_object_id})
        except HTTPException:
            show = None

    return {
        "id": cleaned_id,
        "title": episode.get("title") or "Podcast episode",
        "audioUrl": episode.get("audioUrl") or "",
        "mimeType": episode.get("mimeType") or episode.get("audioMimeType") or "",
        "showTitle": (show or {}).get("title") or "Podcast",
        "mediaType": episode.get("mediaType") or "audio",
        "videoUrl": episode.get("videoUrl") or "",
    }


@router.get("/episode/{id}/download")
async def download_podcast_episode(
    request: Request,
    id: str = Path(..., min_length=1, max_length=64),
    current_user: dict = Depends(get_current_user),
):
    episode = await _resolve_podcast_episode_for_download(id)
    if (
        str(episode.get("mediaType") or "audio").lower() == "video"
        and str(episode.get("videoUrl") or "") == str(episode.get("audioUrl") or "")
    ):
        raise HTTPException(status_code=415, detail="Video-only podcast episodes are not available for audio downloads.")

    source_url = str(episode.get("audioUrl") or "").strip()
    if not source_url:
        raise HTTPException(status_code=404, detail="No audio source is available for this episode.")

    try:
        source_url = assert_public_http_url(source_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="The episode audio source URL is invalid.") from exc

    range_header = request.headers.get("range") if request is not None else None
    upstream_headers = {"Accept": "audio/*, application/octet-stream;q=0.9"}
    if range_header:
        upstream_headers["Range"] = range_header

    client = None
    response = None
    current_url = source_url
    visited = set()
    timeout = HttpxTimeout(connect=6.0, read=30.0, write=10.0, pool=5.0)

    try:
        for _ in range(PODCAST_DOWNLOAD_MAX_REDIRECTS + 1):
            if current_url in visited:
                raise HTTPException(status_code=502, detail="The podcast source returned a redirect loop.")
            visited.add(current_url)
            try:
                current_url = assert_public_http_url(current_url)
                parsed_target = urlparse(current_url)
                if parsed_target.username or parsed_target.password:
                    raise ValueError("URL credentials are not permitted.")
                client = create_pinned_client(current_url, timeout=timeout)
                upstream_request = client.build_request("GET", current_url, headers=upstream_headers)
                response = await client.send(upstream_request, stream=True)
            except ValueError as exc:
                if client:
                    await client.aclose()
                    client = None
                raise HTTPException(status_code=400, detail="The episode audio source URL is invalid.") from exc
            except Exception as exc:
                if client:
                    await client.aclose()
                    client = None
                logger.warning("Podcast audio fetch failed for episode %s: %s", id, type(exc).__name__)
                raise HTTPException(status_code=502, detail="Unable to retrieve the podcast audio source.") from exc

            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                await response.aclose()
                await client.aclose()
                response = None
                client = None
                if not location:
                    raise HTTPException(status_code=502, detail="The podcast source returned an invalid redirect.")
                current_url = urljoin(current_url, location)
                try:
                    assert_public_http_url(current_url)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail="The podcast source redirected to an invalid URL.") from exc
                continue
            break
        else:
            raise HTTPException(status_code=502, detail="The podcast source redirected too many times.")

        if response is None or client is None:
            raise HTTPException(status_code=502, detail="Unable to open the podcast audio source.")

        if response.status_code not in {200, 206}:
            upstream_status = response.status_code
            await response.aclose()
            await client.aclose()
            response = None
            client = None
            if upstream_status == 404 or upstream_status == 410:
                raise HTTPException(status_code=404, detail="This podcast episode is no longer available.")
            raise HTTPException(status_code=502, detail="The podcast source could not provide the audio file.")

        mime_type = _podcast_audio_mime(
            response.headers.get("content-type", ""),
            current_url,
            str(episode.get("mimeType") or ""),
        )
        raw_length = response.headers.get("content-length")
        content_length = None
        if raw_length:
            try:
                content_length = int(raw_length)
            except ValueError:
                content_length = None
            if content_length is not None and content_length < 0:
                content_length = None
        content_range = response.headers.get("content-range", "")
        total_match = re.search(r"/(\d+)$", content_range)
        if total_match and int(total_match.group(1)) > PODCAST_DOWNLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="This episode exceeds the 500 MiB download limit.")
        if content_length is not None and content_length > PODCAST_DOWNLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="This episode exceeds the 500 MiB download limit.")

        filename, encoded_filename = _podcast_download_filename(
            str(episode.get("title") or "Podcast episode"),
            mime_type,
        )

        async def stream_bytes():
            sent = 0
            try:
                async for chunk in response.aiter_raw():
                    sent += len(chunk)
                    if sent > PODCAST_DOWNLOAD_MAX_BYTES:
                        raise RuntimeError("Podcast episode exceeded the download size limit.")
                    if chunk:
                        yield chunk
            finally:
                await response.aclose()
                await client.aclose()

        outgoing_headers = {
            "Content-Type": mime_type,
            "Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{encoded_filename}",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Expose-Headers": "Content-Length, Content-Disposition, Content-Range, Accept-Ranges, Content-Type",
        }
        for header in ("content-length", "content-range", "accept-ranges", "etag", "last-modified"):
            value = response.headers.get(header)
            if value:
                outgoing_headers[header.title()] = value

        status_code = response.status_code
        return StreamingResponse(stream_bytes(), status_code=status_code, headers=outgoing_headers, media_type=mime_type)
    except HTTPException:
        if response is not None:
            await response.aclose()
        if client is not None:
            await client.aclose()
        raise
    except Exception as exc:
        if response is not None:
            await response.aclose()
        if client is not None:
            await client.aclose()
        logger.warning("Podcast download setup failed for episode %s: %s", id, type(exc).__name__)
        raise HTTPException(status_code=502, detail="Unable to prepare the podcast download.") from exc


# ─── Podcast resume progress ───
# Per-episode playback position so users can pick up where they left off.
# The player stores one row per (userId, episodeId); the frontend treats a
# position within a few seconds of the end as "completed" and deletes it.

@router.get("/progress")
async def get_podcast_progress(current_user: dict = Depends(get_current_user)):
    """List all saved podcast progress entries for the current user."""
    try:
        database = db.get_db()
        cursor = database[db.PODCAST_PROGRESS].find(
            {"userId": current_user["id"]}
        ).sort("updatedAt", -1)
        entries = []
        async for doc in cursor:
            entries.append({
                "episodeId": doc["episodeId"],
                "positionSeconds": doc.get("positionSeconds", 0),
                "durationSeconds": doc.get("durationSeconds", 0),
                "updatedAt": doc.get("updatedAt", datetime.utcnow()).isoformat(),
            })
        return {"success": True, "data": {"progress": entries}}
    except Exception as e:
        logger.error(f"Error listing podcast progress: {str(e)}")
        return {"success": False, "error": "Failed to load podcast progress."}


@router.get("/progress/{episode_id}")
async def get_podcast_episode_progress(
    episode_id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    """Return the saved playback position for a single episode (0 if none)."""
    try:
        database = db.get_db()
        cleaned = sanitize_text(episode_id, max_length=128)
        doc = await database[db.PODCAST_PROGRESS].find_one(
            {"userId": current_user["id"], "episodeId": cleaned}
        )
        if not doc:
            return {"success": True, "data": {"positionSeconds": 0}}
        return {
            "success": True,
            "data": {
                "episodeId": doc["episodeId"],
                "positionSeconds": doc.get("positionSeconds", 0),
                "durationSeconds": doc.get("durationSeconds", 0),
            }
        }
    except Exception as e:
        logger.error(f"Error loading podcast progress: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


@router.put("/progress/{episode_id}")
async def save_podcast_progress(
    episode_id: str = Path(...),
    payload: PodcastProgressRequest = Body(...),
    current_user: dict = Depends(get_current_user)
):
    """Upsert the playback position for an episode."""
    try:
        database = db.get_db()
        cleaned = sanitize_text(episode_id, max_length=128)
        position = max(0.0, float(payload.positionSeconds))
        duration = max(0.0, float(payload.durationSeconds))

        await database[db.PODCAST_PROGRESS].update_one(
            {"userId": current_user["id"], "episodeId": cleaned},
            {
                "$set": {
                    "positionSeconds": position,
                    "durationSeconds": duration,
                    "updatedAt": datetime.utcnow(),
                }
            },
            upsert=True,
        )
        return {"success": True, "data": {"episodeId": cleaned, "positionSeconds": position}}
    except Exception as e:
        logger.error(f"Error saving podcast progress: {str(e)}")
        return {"success": False, "error": "Failed to save podcast progress."}


@router.delete("/progress/{episode_id}")
async def clear_podcast_progress(
    episode_id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    """Remove the saved position for an episode (e.g. when it is finished)."""
    try:
        database = db.get_db()
        cleaned = sanitize_text(episode_id, max_length=128)
        await database[db.PODCAST_PROGRESS].delete_one(
            {"userId": current_user["id"], "episodeId": cleaned}
        )
        return {"success": True, "data": {"message": "Progress cleared."}}
    except Exception as e:
        logger.error(f"Error clearing podcast progress: {str(e)}")
        return {"success": False, "error": "Failed to clear podcast progress."}
