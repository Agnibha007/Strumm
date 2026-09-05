import feedparser
import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body
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
from app.services.security import assert_public_http_url, parse_object_id, sanitize_text
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
            video_url = ""
            video_available = False
            media_type = "audio"
            audio_variants = {}
            
            if "enclosures" in entry:
                for enc in entry.enclosures:
                    enc_type = enc.get("type", "")
                    enc_url = enc.get("href", "")
                    if enc_type.startswith("audio/"):
                        if not audio_url:
                            audio_url = enc_url
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
