from fastapi import APIRouter, Depends, HTTPException, Body
from typing import Optional, Dict, Any, List
from bson import ObjectId
from datetime import datetime
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import SongSchema, UserSettingsSchema
from app.services.security import parse_object_id, sanitize_positive_int, sanitize_text
from pydantic import BaseModel
import logging

logger = logging.getLogger("strumm-user")
router = APIRouter(tags=["user"])

# User Profile
@router.get("/profile")
async def get_profile(current_user: dict = Depends(get_current_user)):
    return {
        "success": True,
        "data": current_user
    }

@router.patch("/profile")
async def update_profile(
    displayName: Optional[str] = Body(None),
    avatar: Optional[str] = Body(None),
    theme: Optional[str] = Body(None),
    settings: Optional[UserSettingsSchema] = Body(None),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        update_data = {}
        if displayName is not None:
            cleaned_display_name = sanitize_text(displayName, max_length=120)
            if not cleaned_display_name:
                return {"success": False, "error": "Display name cannot be empty."}
            update_data["displayName"] = cleaned_display_name
        if avatar is not None:
            is_data_uri = avatar.startswith("data:image/")
            max_len = 2_500_000 if is_data_uri else 1500
            update_data["avatar"] = sanitize_text(avatar, max_length=max_len)
        if theme is not None:
            update_data["theme"] = sanitize_text(theme, max_length=80)
            
        if settings is not None:
            # Map settings dictionary
            for key, val in settings.model_dump().items():
                if val is not None:
                    update_data[f"settings.{key}"] = val

        if update_data:
            await database[db.USERS].update_one(
                {"_id": parse_object_id(current_user["id"])},
                {"$set": update_data}
            )

        # Retrieve updated user doc
        user = await database[db.USERS].find_one({"_id": parse_object_id(current_user["id"])})
        user["id"] = str(user["_id"])
        del user["_id"]
        if "createdAt" in user:
            user["createdAt"] = user["createdAt"].isoformat()

        return {
            "success": True,
            "data": user
        }
    except Exception as e:
        logger.error(f"Error updating profile: {str(e)}")
        return {"success": False, "error": f"Failed to update profile: {str(e)}"}

# Library Aggregator
@router.get("/library")
async def get_library(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        # 1. Playlists
        playlists_cursor = database[db.PLAYLISTS].find({"userId": current_user["id"]})
        playlists = []
        async for doc in playlists_cursor:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
            playlists.append(doc)
            
        # 2. Liked Songs Count
        liked_count = await database[db.LIKED_SONGS].count_documents({"userId": current_user["id"]})
        
        return {
            "success": True,
            "data": {
                "playlists": playlists,
                "likedSongsCount": liked_count
            }
        }
    except Exception as e:
        logger.error(f"Error fetching library: {str(e)}")
        return {"success": False, "error": str(e)}

# Liked Songs CRUD
@router.get("/liked")
async def get_liked_songs(
    limit: int = 50,
    skip: int = 0,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        cursor = database[db.LIKED_SONGS].find({"userId": current_user["id"]}).sort("likedAt", -1).skip(skip).limit(limit)
        liked_songs = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
            if "likedAt" in doc:
                doc["likedAt"] = doc["likedAt"].isoformat()
            liked_songs.append(doc)
            
        return {
            "success": True,
            "data": liked_songs
        }
    except Exception as e:
        logger.error(f"Error listing liked songs: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/liked/{video_id}")
async def check_if_liked(
    video_id: str,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        existing = await database[db.LIKED_SONGS].find_one({
            "userId": current_user["id"],
            "song.videoId": video_id
        })
        return {
            "success": True,
            "data": {"liked": bool(existing)}
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.post("/liked")
async def toggle_like_song(
    song: SongSchema,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        # Check if already liked
        existing = await database[db.LIKED_SONGS].find_one({
            "userId": current_user["id"],
            "song.videoId": song.videoId
        })
        
        if existing:
            # Unlike the song
            await database[db.LIKED_SONGS].delete_one({"_id": existing["_id"]})
            return {
                "success": True,
                "data": {"liked": False, "message": "Song removed from Liked Songs."}
            }
        else:
            # Like the song
            new_like = {
                "userId": current_user["id"],
                "song": song.model_dump(),
                "likedAt": datetime.utcnow()
            }
            await database[db.LIKED_SONGS].insert_one(new_like)
            return {
                "success": True,
                "data": {"liked": True, "message": "Song added to Liked Songs."}
            }
    except Exception as e:
        logger.error(f"Error toggling liked song status: {str(e)}")
        return {"success": False, "error": str(e)}

# History and Statistics (Live Listening Counter backend sync)
@router.get("/history")
async def get_playback_history(
    limit: int = 50,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        cursor = database[db.PLAYBACK_HISTORIES].find({"userId": current_user["id"]}).sort("playedAt", -1).limit(limit)
        history = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
            if "playedAt" in doc:
                doc["playedAt"] = doc["playedAt"].isoformat()
            history.append(doc)
            
        return {
            "success": True,
            "data": history
        }
    except Exception as e:
        logger.error(f"Error loading listening history: {str(e)}")
        return {"success": False, "error": str(e)}

@router.delete("/history")
async def clear_playback_history(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        await database[db.PLAYBACK_HISTORIES].delete_many({"userId": current_user["id"]})
        return {
            "success": True,
            "data": {"message": "Listening history permanently deleted."}
        }
    except Exception as e:
        logger.error(f"Error deleting listening history: {str(e)}")
        return {"success": False, "error": str(e)}

class PlayEventRequest(BaseModel):
    song: SongSchema
    listenDuration: int # seconds listened in this interval (e.g., 30s sync)

class PlayerStateRequest(BaseModel):
    deviceId: str = "primary"
    currentSong: Optional[SongSchema] = None
    queue: List[SongSchema] = []
    volume: float = 0.8
    currentTime: float = 0.0
    isPlaying: bool = False
    currentIndex: int = -1
    isShuffle: bool = False
    repeatMode: str = "none"
    playbackRate: float = 1.0

@router.post("/play-event")
async def register_play_event(
    payload: PlayEventRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        userId = current_user["id"]
        song_dict = payload.song.model_dump()
        duration_delta = sanitize_positive_int(payload.listenDuration, minimum=1, maximum=300)
        
        # 1. Log playback event in history
        history_entry = {
            "userId": userId,
            "song": song_dict,
            "listenDuration": duration_delta,
            "playedAt": datetime.utcnow()
        }
        await database[db.PLAYBACK_HISTORIES].insert_one(history_entry)
        
        # 2. Update user statistics (seconds listened)
        # We increment: totalListeningTime, monthlyListeningTime
        # And we track topSongs/topArtists
        stats_inc = {
            "statistics.totalListeningTime": duration_delta,
            "statistics.monthlyListeningTime": duration_delta
        }
        
        # Check if song is already in user's topSongs or artist in topArtists to increment count,
        # or handle aggregation. For simplicity, we increment listening time directly
        # and we can periodically aggregate top artists, or do it on-the-fly.
        await database[db.USERS].update_one(
            {"_id": parse_object_id(userId)},
            {"$inc": stats_inc}
        )
        
        # Async updates of top artists
        artist_name = song_dict.get("artist", "")
        if artist_name:
            # Check if artist is already tracked in user statistics
            user_doc = await database[db.USERS].find_one({"_id": parse_object_id(userId)})
            top_artists = user_doc.get("statistics", {}).get("topArtists", [])
            
            # Find and update
            found = False
            for art in top_artists:
                if art.get("name", "").lower() == artist_name.lower():
                    art["playCount"] = art.get("playCount", 0) + 1
                    found = True
                    break
            
            if not found:
                top_artists.append({"name": artist_name, "playCount": 1})
                
            # Limit top artists to top 10 sorted by playCount
            top_artists = sorted(top_artists, key=lambda x: x.get("playCount", 0), reverse=True)[:10]
            
            await database[db.USERS].update_one(
                {"_id": parse_object_id(userId)},
                {"$set": {"statistics.topArtists": top_artists}}
            )

        return {
            "success": True,
            "data": {
                "message": f"Listening stats updated. +{duration_delta} seconds added.",
                "totalListeningTime": (current_user.get("statistics", {}).get("totalListeningTime", 0) or 0) + duration_delta
            }
        }
    except Exception as e:
        logger.error(f"Error registering playback event: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/player-state")
async def get_player_state(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        state = await database[db.PLAYER_STATES].find_one({"userId": current_user["id"], "deviceId": "primary"})
        if not state:
            return {"success": True, "data": None}

        state["id"] = str(state["_id"])
        del state["_id"]
        if "updatedAt" in state:
            state["updatedAt"] = state["updatedAt"].isoformat()
        return {"success": True, "data": state}
    except Exception as e:
        logger.error(f"Error loading player state: {str(e)}")
        return {"success": False, "error": str(e)}

@router.put("/player-state")
async def save_player_state(
    payload: PlayerStateRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        volume = max(0.0, min(1.0, float(payload.volume)))
        current_time = max(0.0, float(payload.currentTime))
        playback_rate = max(0.25, min(2.0, float(payload.playbackRate)))
        repeat_mode = payload.repeatMode if payload.repeatMode in {"none", "all", "one"} else "none"

        state_doc = {
            "userId": current_user["id"],
            "deviceId": "primary",
            "currentSong": payload.currentSong.model_dump() if payload.currentSong else None,
            "queue": [song.model_dump() for song in payload.queue[:200]],
            "volume": volume,
            "currentTime": current_time,
            "isPlaying": payload.isPlaying,
            "currentIndex": payload.currentIndex,
            "isShuffle": payload.isShuffle,
            "repeatMode": repeat_mode,
            "playbackRate": playback_rate,
            "updatedAt": datetime.utcnow()
        }

        await database[db.PLAYER_STATES].update_one(
            {"userId": current_user["id"], "deviceId": "primary"},
            {"$set": state_doc},
            upsert=True
        )
        return {"success": True, "data": {"message": "Player state saved."}}
    except Exception as e:
        logger.error(f"Error saving player state: {str(e)}")
        return {"success": False, "error": str(e)}

@router.delete("/profile")
async def delete_user_account(current_user: dict = Depends(get_current_user)):
    user_id = current_user["id"]
    try:
        database = db.get_db()
        oid = parse_object_id(user_id)
        
        # Delete User document
        await database[db.USERS].delete_one({"_id": oid})
        
        # Delete user playlists
        await database[db.PLAYLISTS].delete_many({"userId": user_id})
        
        # Delete user liked songs
        await database[db.LIKED_SONGS].delete_many({"userId": user_id})
        
        # Delete user history
        await database[db.PLAYBACK_HISTORIES].delete_many({"userId": user_id})
        
        # Delete user player state
        await database[db.PLAYER_STATES].delete_many({"userId": user_id})
        
        # Delete user share tokens
        await database[db.SHARES].delete_many({"userId": user_id})
        
        # Delete user follows
        await database["follows"].delete_many({"userId": user_id})
        
        logger.info(f"User account {user_id} and all associated collections deleted successfully.")
        return {
            "success": True,
            "data": {"message": "Account and all associated collections successfully deleted."}
        }
    except Exception as e:
        logger.error(f"Error deleting user account {user_id}: {str(e)}")
        return {"success": False, "error": f"Failed to delete account: {str(e)}"}
