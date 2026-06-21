import secrets
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body
from typing import Optional, Dict, Any
from bson import ObjectId
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.security import parse_object_id, sanitize_enum, sanitize_positive_int, sanitize_text, sanitize_youtube_id
from pydantic import BaseModel
import logging

logger = logging.getLogger("strumm-share")
router = APIRouter(prefix="/share", tags=["share"])

class CreateShareRequest(BaseModel):
    contentType: str # song, playlist
    contentId: str
    expiryDays: Optional[int] = None

@router.post("")
async def create_share_link(
    payload: CreateShareRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        content_type = sanitize_enum(payload.contentType, {"song", "playlist"}, "song")
        content_id = sanitize_text(payload.contentId, max_length=64)

        if content_type == "playlist":
            playlist_oid = parse_object_id(content_id)
            playlist = await database[db.PLAYLISTS].find_one({"_id": playlist_oid})
            if not playlist or playlist.get("userId") != current_user["id"]:
                return {"success": False, "error": "Playlist not found or not owned by current user."}
        else:
            content_id = sanitize_youtube_id(content_id)

        token = secrets.token_urlsafe(8) # short, URL-safe token (e.g. 10-12 chars)
        
        expiry_date = None
        if payload.expiryDays:
            expiry_days = sanitize_positive_int(payload.expiryDays, minimum=1, maximum=30)
            expiry_date = datetime.utcnow() + timedelta(days=expiry_days)
            
        share_doc = {
            "userId": current_user["id"],
            "contentType": content_type,
            "contentId": content_id,
            "shareToken": token,
            "views": 0,
            "expiry": expiry_date,
            "createdAt": datetime.utcnow()
        }
        
        await database[db.SHARES].insert_one(share_doc)
        
        return {
            "success": True,
            "data": {
                "shareToken": token,
                "shareUrl": f"/share/{token}",
                "expiry": expiry_date.isoformat() if expiry_date else None
            }
        }
    except Exception as e:
        logger.error(f"Error creating share link: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/{token}")
async def get_shared_content(
    token: str = Path(..., description="The sharing token")
):
    try:
        database = db.get_db()
        share = await database[db.SHARES].find_one({"shareToken": token})
        
        if not share:
            return {"success": False, "error": "Shared content link not found or expired."}
            
        # Check expiry
        if share.get("expiry") and datetime.utcnow() > share["expiry"]:
            await database[db.SHARES].delete_one({"_id": share["_id"]})
            return {"success": False, "error": "This sharing link has expired."}
            
        # Increment views
        await database[db.SHARES].update_one(
            {"_id": share["_id"]},
            {"$inc": {"views": 1}}
        )
        
        content_id = sanitize_text(share["contentId"], max_length=64)
        content_type = sanitize_enum(share["contentType"], {"song", "playlist"}, "song")
        content_data = None
        
        # Resolve shared entity details
        if content_type == "playlist":
            playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(content_id)})
            if playlist:
                if playlist.get("visibility") != "public" and playlist.get("userId") != share.get("userId"):
                    return {"success": False, "error": "Shared playlist is no longer public."}
                playlist["id"] = str(playlist["_id"])
                del playlist["_id"]
                content_data = playlist
        elif content_type == "song":
            # Lookup song in active playlist songs or histories
            song_doc = await database[db.PLAYLISTS].find_one(
                {"songs.videoId": content_id},
                {"songs.$": 1}
            )
            if song_doc and "songs" in song_doc:
                content_data = song_doc["songs"][0]
            else:
                liked_doc = await database[db.LIKED_SONGS].find_one({"song.videoId": content_id})
                if liked_doc:
                    content_data = liked_doc["song"]
                    
            if not content_data:
                # Mock resolve details
                content_data = {
                    "videoId": content_id,
                    "title": "Shared Track",
                    "artist": "Various Artists",
                    "thumbnail": f"https://img.youtube.com/vi/{content_id}/hqdefault.jpg",
                    "duration": 220
                }
                
        if not content_data:
            return {"success": False, "error": "Shared item could not be found in catalog."}
            
        return {
            "success": True,
            "data": {
                "contentType": content_type,
                "content": content_data,
                "views": share.get("views", 0) + 1
            }
        }
    except Exception as e:
        logger.error(f"Error opening shared content {token}: {str(e)}")
        return {"success": False, "error": str(e)}
