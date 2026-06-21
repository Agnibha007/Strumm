from fastapi import APIRouter, Depends, HTTPException, Body
from typing import Optional, Dict, Any, List
from bson import ObjectId
from datetime import datetime, timedelta
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import SongSchema, UserSettingsSchema
from app.services.security import parse_object_id, sanitize_positive_int, sanitize_text
from pydantic import BaseModel
import logging

logger = logging.getLogger("strumm-user")
router = APIRouter(tags=["user"])

# Helper to calculate sound DNA
def calculate_sound_dna(histories: List[Dict[str, Any]]) -> Dict[str, int]:
    if not histories:
        return {
            "energy": 5,
            "discovery": 5,
            "nostalgia": 5,
            "variety": 5,
            "repeatRate": 5
        }
    
    total_plays = len(histories)
    
    # 1. Energy
    energy_score = 5
    high_energy_count = 0
    low_energy_count = 0
    high_energy_keywords = {"funk", "remix", "dance", "rock", "hype", "party", "rap", "metal", "electronic", "funk mi camino", "illuminati"}
    low_energy_keywords = {"lo-fi", "sleep", "binaural", "serenity", "delta", "theta", "gamma", "acoustic", "sad", "relax", "meditation"}
    
    # 2. Nostalgia
    nostalgia_count = 0
    nostalgia_keywords = {"classic", "retro", "19", "old", "vintage", "hemanta", "sandhya", "kishore", "lata", "rd burman", "antique", "ghazal"}
    
    # Unique tracks/artists
    unique_songs = set()
    unique_artists = set()
    song_counts = {}
    
    for h in histories:
        song = h.get("song", {})
        title = str(song.get("title", "")).lower()
        artist = str(song.get("artist", "")).lower()
        vid = song.get("videoId")
        if vid:
            unique_songs.add(vid)
            song_counts[vid] = song_counts.get(vid, 0) + 1
        if artist:
            unique_artists.add(artist)
            
        if any(kw in title or kw in artist for kw in high_energy_keywords):
            high_energy_count += 1
        if any(kw in title or kw in artist for kw in low_energy_keywords):
            low_energy_count += 1
        if any(kw in title or kw in artist for kw in nostalgia_keywords):
            nostalgia_count += 1
            
    if high_energy_count + low_energy_count > 0:
        energy_score = int(round((high_energy_count / (high_energy_count + low_energy_count)) * 10))
        energy_score = max(1, min(10, energy_score))
        
    # 2. Discovery
    discovery_score = int(round((len(unique_artists) / max(1, total_plays)) * 10))
    discovery_score = max(1, min(10, discovery_score))
    
    # 3. Nostalgia
    nostalgia_score = int(round((nostalgia_count / total_plays) * 10))
    nostalgia_score = max(1, min(10, nostalgia_score))
    
    # 4. Variety
    variety_score = int(round((len(unique_songs) / max(1, total_plays)) * 10))
    variety_score = max(1, min(10, variety_score))
    
    # 5. Repeat Rate
    repeated_songs = sum(1 for c in song_counts.values() if c > 1)
    repeat_rate_score = int(round((repeated_songs / max(1, len(unique_songs))) * 10))
    repeat_rate_score = max(1, min(10, repeat_rate_score))
    
    return {
        "energy": energy_score,
        "discovery": discovery_score,
        "nostalgia": nostalgia_score,
        "variety": variety_score,
        "repeatRate": repeat_rate_score
    }

def get_music_personality(histories: List[Dict[str, Any]], sound_dna: Dict[str, int]) -> str:
    if not histories:
        return "Novice Listener"
    
    midnight_count = 0
    for h in histories:
        played_at = h.get("playedAt")
        if isinstance(played_at, datetime):
            hour = played_at.hour
            if 0 <= hour < 6:
                midnight_count += 1
                
    if midnight_count / len(histories) > 0.4:
        return "Midnight Explorer"
        
    if sound_dna["discovery"] > 7:
        return "Sonic Pathfinder"
        
    if sound_dna["repeatRate"] > 7:
        return "Memory Collector"
        
    if sound_dna["nostalgia"] > 6:
        return "Retro Archivist"
        
    return "Melody Harmonizer"

# User Profile
@router.get("/profile")
async def get_profile(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        histories = await database[db.PLAYBACK_HISTORIES].find({"userId": current_user["id"]}).to_list(length=1000)
        dna = calculate_sound_dna(histories)
        current_user["soundDNA"] = dna
    except Exception as e:
        logger.error(f"Error calculating soundDNA for profile: {e}")
        current_user["soundDNA"] = {
            "energy": 5, "discovery": 5, "nostalgia": 5, "variety": 5, "repeatRate": 5
        }
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
        user_id_str = current_user["id"]
        user_id_oid = ObjectId(user_id_str)
        # 1. Playlists
        playlists_cursor = database[db.PLAYLISTS].find({"userId": {"$in": [user_id_str, user_id_oid]}})
        playlists = []
        async for doc in playlists_cursor:
            doc["id"] = str(doc["_id"])
            doc["userId"] = str(doc["userId"])
            del doc["_id"]
            playlists.append(doc)
            
        # 2. Liked Songs Count
        liked_count = await database[db.LIKED_SONGS].count_documents({"userId": {"$in": [user_id_str, user_id_oid]}})
        
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
        user_id_str = current_user["id"]
        user_id_oid = ObjectId(user_id_str)
        cursor = database[db.LIKED_SONGS].find({"userId": {"$in": [user_id_str, user_id_oid]}}).sort("likedAt", -1).skip(skip).limit(limit)
        liked_songs = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            doc["userId"] = str(doc["userId"])
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
        user_id_str = current_user["id"]
        user_id_oid = ObjectId(user_id_str)
        existing = await database[db.LIKED_SONGS].find_one({
            "userId": {"$in": [user_id_str, user_id_oid]},
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
        user_id_str = current_user["id"]
        user_id_oid = ObjectId(user_id_str)
        # Check if already liked
        existing = await database[db.LIKED_SONGS].find_one({
            "userId": {"$in": [user_id_str, user_id_oid]},
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
                "userId": user_id_str,
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
        user_id_str = current_user["id"]
        user_id_oid = ObjectId(user_id_str)
        cursor = database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": [user_id_str, user_id_oid]}}).sort("playedAt", -1).limit(limit)
        history = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            doc["userId"] = str(doc["userId"])
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
        user_id_str = current_user["id"]
        user_id_oid = ObjectId(user_id_str)
        await database[db.PLAYBACK_HISTORIES].delete_many({"userId": {"$in": [user_id_str, user_id_oid]}})
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
        userId = ObjectId(current_user["id"])
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
        
        # Update user activity if showListeningActivity is enabled (defaults to True)
        show_act = current_user.get("settings", {}).get("showListeningActivity", True)
        if show_act:
            await database["activities"].update_one(
                {"userId": userId},
                {"$set": {
                    "userId": userId,
                    "type": "listening",
                    "song": song_dict,
                    "timestamp": datetime.utcnow(),
                    "expiresAt": datetime.utcnow() + timedelta(minutes=5)
                }},
                upsert=True
            )
        
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
        
        # Delete user memories
        await database["songMemories"].delete_many({"userId": user_id})
        
        logger.info(f"User account {user_id} and all associated collections deleted successfully.")
        return {
            "success": True,
            "data": {"message": "Account and all associated collections successfully deleted."}
        }
    except Exception as e:
        logger.error(f"Error deleting user account {user_id}: {str(e)}")
        return {"success": False, "error": f"Failed to delete account: {str(e)}"}

class MemoryCreateRequest(BaseModel):
    song: SongSchema
    note: str
    visibility: str = "private" # public, private

@router.get("/replay")
async def get_replay(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        histories = await database[db.PLAYBACK_HISTORIES].find({"userId": current_user["id"]}).to_list(length=2000)
        
        # Listening minutes: sum(listenDuration) / 60
        total_seconds = sum(h.get("listenDuration", 0) for h in histories)
        total_minutes = int(total_seconds // 60)
        
        # Top Songs / Artists / Time of Day
        song_groups = {}
        artist_groups = {}
        time_slots = {"Morning (6AM-12PM)": 0, "Afternoon (12PM-6PM)": 0, "Evening (6PM-12AM)": 0, "Midnight (12AM-6AM)": 0}
        
        for h in histories:
            song = h.get("song", {})
            vid = song.get("videoId")
            title = song.get("title", "Unknown Track")
            artist = song.get("artist", "Unknown Artist")
            thumbnail = song.get("thumbnail", "")
            duration = song.get("duration", 180)
            listen_dur = h.get("listenDuration", 0)
            
            played_at = h.get("playedAt")
            played_at_str = played_at.isoformat() if isinstance(played_at, datetime) else str(played_at) if played_at else ""
            
            if vid:
                if vid not in song_groups:
                    song_groups[vid] = {
                        "videoId": vid,
                        "title": title,
                        "artist": artist,
                        "thumbnail": thumbnail,
                        "image": thumbnail,
                        "duration": duration,
                        "plays": 0,
                        "count": 0, # backward compatibility
                        "totalSeconds": 0,
                        "lastPlayed": played_at_str,
                        "playedAtDateTime": played_at
                    }
                g = song_groups[vid]
                g["totalSeconds"] += listen_dur
                # Count plays as: (Total listened time / Song duration), but at least 1 if there's any active listening history entry
                calculated_plays = max(1, int(round(g["totalSeconds"] / max(1, duration))))
                g["plays"] = calculated_plays
                g["count"] = calculated_plays
                if played_at and (not g["playedAtDateTime"] or played_at > g["playedAtDateTime"]):
                    g["playedAtDateTime"] = played_at
                    g["lastPlayed"] = played_at_str

            if artist:
                if artist not in artist_groups:
                    artist_groups[artist] = {
                        "artist": artist,
                        "thumbnail": thumbnail,
                        "image": thumbnail,
                        "plays": 0,
                        "count": 0, # backward compatibility
                        "totalSeconds": 0,
                        "uniqueSongsSet": set()
                    }
                ag = artist_groups[artist]
                ag["totalSeconds"] += listen_dur
                if vid:
                    ag["uniqueSongsSet"].add(vid)
                
            if isinstance(played_at, datetime):
                hour = played_at.hour
                if 6 <= hour < 12:
                    time_slots["Morning (6AM-12PM)"] += 1
                elif 12 <= hour < 18:
                    time_slots["Afternoon (12PM-6PM)"] += 1
                elif 18 <= hour < 24:
                    time_slots["Evening (6PM-12AM)"] += 1
                else:
                    time_slots["Midnight (12AM-6AM)"] += 1

        # Post-process songs
        for vid, g in song_groups.items():
            g["minutes"] = round(g["totalSeconds"] / 60)
            g["totalMinutes"] = g["minutes"]
            if "playedAtDateTime" in g:
                del g["playedAtDateTime"]
            del g["totalSeconds"]

        # Post-process artists
        for name, ag in artist_groups.items():
            ag["minutes"] = round(ag["totalSeconds"] / 60)
            ag["uniqueSongs"] = len(ag["uniqueSongsSet"])
            # Sum up actual calculated song plays for this artist
            artist_plays = sum(g["plays"] for g in song_groups.values() if g.get("artist", "").lower() == name.lower())
            ag["plays"] = max(1, artist_plays)
            ag["count"] = ag["plays"]
            del ag["uniqueSongsSet"]
            del ag["totalSeconds"]
            
        sorted_songs = sorted(song_groups.values(), key=lambda x: x["plays"], reverse=True)[:5]
        sorted_artists = sorted(artist_groups.values(), key=lambda x: x["plays"], reverse=True)[:5]
        favorite_time = max(time_slots, key=time_slots.get) if histories else "Evening (6PM-12AM)"
        
        # Sound DNA & Personality
        sound_dna = calculate_sound_dna(histories)
        personality = get_music_personality(histories, sound_dna)
        
        # Calculate discovery score
        discovery_score = sound_dna["discovery"] * 10
        
        # Insufficient history flag (e.g. less than 5 records)
        insufficient_history = len(histories) < 5
        
        # Simulated/mapped top genres
        genres = {}
        for h in histories:
            title = str(h.get("song", {}).get("title", "")).lower()
            artist = str(h.get("song", {}).get("artist", "")).lower()
            if "funk" in title or "camino" in title:
                genres["Funk"] = genres.get("Funk", 0) + 1
            elif "serenity" in title or "waves" in title or "lo-fi" in title:
                genres["Ambient"] = genres.get("Ambient", 0) + 1
            elif "singh" in artist or "pritam" in artist:
                genres["Romantic Bollywood"] = genres.get("Romantic Bollywood", 0) + 1
            elif "mukherjee" in artist:
                genres["Bengali Classic"] = genres.get("Bengali Classic", 0) + 1
            else:
                genres["Pop / Indie"] = genres.get("Pop / Indie", 0) + 1
        sorted_genres = sorted(genres.items(), key=lambda x: x[1], reverse=True)[:3]
        top_genres = [g[0] for g in sorted_genres] if sorted_genres else ["Pop / Indie"]
        
        return {
            "success": True,
            "data": {
                "totalMinutes": total_minutes,
                "topSongs": sorted_songs,
                "topArtists": sorted_artists,
                "topGenres": top_genres,
                "favoriteTime": favorite_time,
                "discoveryScore": discovery_score,
                "personality": personality,
                "soundDNA": sound_dna,
                "insufficientHistory": insufficient_history
            }
        }
    except Exception as e:
        logger.error(f"Error generating Strumm Replay: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/users/{user_id}/taste-match")
async def get_taste_match(user_id: str, current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        my_id = current_user["id"]
        
        if my_id == user_id:
            return {
                "success": True,
                "data": {
                    "percentage": 100,
                    "commonArtists": [],
                    "commonSongs": [],
                    "sharedMoods": ["Myself"]
                }
            }
            
        target_user = await database[db.USERS].find_one({"_id": parse_object_id(user_id)})
        if not target_user:
            return {"success": False, "error": "Target user not found"}
            
        # Get histories
        my_histories = await database[db.PLAYBACK_HISTORIES].find({"userId": my_id}).to_list(length=1000)
        their_histories = await database[db.PLAYBACK_HISTORIES].find({"userId": user_id}).to_list(length=1000)
        
        my_artists = {str(h.get("song", {}).get("artist", "")).strip() for h in my_histories if h.get("song", {}).get("artist")}
        their_artists = {str(h.get("song", {}).get("artist", "")).strip() for h in their_histories if h.get("song", {}).get("artist")}
        
        my_songs = {str(h.get("song", {}).get("videoId", "")) for h in my_histories if h.get("song", {}).get("videoId")}
        their_songs = {str(h.get("song", {}).get("videoId", "")) for h in their_histories if h.get("song", {}).get("videoId")}
        
        common_artists = list(my_artists.intersection(their_artists))
        common_songs_ids = my_songs.intersection(their_songs)
        
        # Get common song details
        common_songs = []
        for vid in common_songs_ids:
            # find first song matching in histories
            for h in my_histories:
                if h.get("song", {}).get("videoId") == vid:
                    common_songs.append(h.get("song", {}).get("title"))
                    break
            if len(common_songs) >= 5:
                break
                
        # Calculate matching percentage
        artists_union = my_artists.union(their_artists)
        artist_match_score = (len(common_artists) / max(1, len(artists_union))) * 100
        
        songs_union = my_songs.union(their_songs)
        song_match_score = (len(common_songs_ids) / max(1, len(songs_union))) * 100
        
        match_percentage = int(round(max(15, min(95, 20 + artist_match_score * 0.5 + song_match_score * 0.5 + (15 if common_artists else 0)))))
        
        shared_moods = []
        if match_percentage > 70:
            shared_moods = ["Harmonious", "Eclectic"]
        elif match_percentage > 45:
            shared_moods = ["Chilled", "Curious"]
        else:
            shared_moods = ["Diverse", "Independent"]
            
        return {
            "success": True,
            "data": {
                "percentage": match_percentage,
                "commonArtists": common_artists[:5],
                "commonSongs": common_songs[:5],
                "sharedMoods": shared_moods
            }
        }
    except Exception as e:
        logger.error(f"Error calculating taste match: {str(e)}")
        return {"success": False, "error": str(e)}

# --- Song Memories CRUD ---

@router.get("/memories")
async def get_memories(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        memories = await database["songMemories"].find({"userId": current_user["id"]}).sort("createdAt", -1).to_list(length=100)
        for m in memories:
            m["id"] = str(m["_id"])
            del m["_id"]
            if "date" in m and m["date"]:
                m["date"] = m["date"].isoformat()
            if "createdAt" in m and m["createdAt"]:
                m["createdAt"] = m["createdAt"].isoformat()
        return {"success": True, "data": memories}
    except Exception as e:
        logger.error(f"Error fetching memories: {str(e)}")
        return {"success": False, "error": str(e)}

@router.post("/memories")
async def create_memory(payload: MemoryCreateRequest, current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        memory_doc = {
            "userId": current_user["id"],
            "song": payload.song.model_dump(),
            "note": sanitize_text(payload.note, max_length=1000),
            "date": datetime.utcnow(),
            "visibility": payload.visibility if payload.visibility in {"public", "private"} else "private",
            "createdAt": datetime.utcnow()
        }
        res = await database["songMemories"].insert_one(memory_doc)
        memory_doc["id"] = str(res.inserted_id)
        del memory_doc["_id"]
        memory_doc["date"] = memory_doc["date"].isoformat()
        memory_doc["createdAt"] = memory_doc["createdAt"].isoformat()
        return {"success": True, "data": memory_doc}
    except Exception as e:
        logger.error(f"Error creating memory: {str(e)}")
        return {"success": False, "error": str(e)}

@router.put("/memories/{memory_id}")
async def update_memory(memory_id: str, note: str = Body(..., embed=True), visibility: str = Body("private", embed=True), current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        memory_oid = parse_object_id(memory_id)
        
        memory = await database["songMemories"].find_one({"_id": memory_oid, "userId": current_user["id"]})
        if not memory:
            return {"success": False, "error": "Memory not found or access denied."}
            
        await database["songMemories"].update_one(
            {"_id": memory_oid},
            {"$set": {
                "note": sanitize_text(note, max_length=1000),
                "visibility": visibility if visibility in {"public", "private"} else "private"
            }}
        )
        return {"success": True, "data": {"message": "Memory updated successfully."}}
    except Exception as e:
        logger.error(f"Error updating memory {memory_id}: {str(e)}")
        return {"success": False, "error": str(e)}

@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str, current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        memory_oid = parse_object_id(memory_id)
        
        res = await database["songMemories"].delete_one({"_id": memory_oid, "userId": current_user["id"]})
        if res.deleted_count == 0:
            return {"success": False, "error": "Memory not found or access denied."}
            
        return {"success": True, "data": {"message": "Memory deleted successfully."}}
    except Exception as e:
        logger.error(f"Error deleting memory {memory_id}: {str(e)}")
        return {"success": False, "error": str(e)}

# --- Public Profiles (@username) ---

@router.get("/public/{username}")
async def get_public_profile(username: str):
    try:
        database = db.get_db()
        user = await database[db.USERS].find_one({"username": username.lower()})
        if not user:
            return {"success": False, "error": "User profile not found."}
            
        # Respect publicPassport privacy setting
        passport_enabled = user.get("settings", {}).get("publicPassport", True)
        if not passport_enabled:
            return {"success": False, "error": "This passport is set to private."}

        user_id = str(user["_id"])
        
        # Get public playlists
        playlists = await database[db.PLAYLISTS].find({"userId": {"$in": [user_id, ObjectId(user_id)]}, "visibility": "public"}).to_list(length=30)
        for p in playlists:
            p["id"] = str(p["_id"])
            p["userId"] = str(p["userId"])
            del p["_id"]
            if "createdAt" in p:
                p["createdAt"] = p["createdAt"].isoformat()
                
        # Get public memories
        memories = await database["songMemories"].find({"userId": {"$in": [user_id, ObjectId(user_id)]}, "visibility": "public"}).sort("createdAt", -1).to_list(length=20)
        for m in memories:
            m["id"] = str(m["_id"])
            m["userId"] = str(m["userId"])
            del m["_id"]
            if "date" in m:
                m["date"] = m["date"].isoformat()
            if "createdAt" in m:
                m["createdAt"] = m["createdAt"].isoformat()
                
        # Get stats
        histories = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": [user_id, ObjectId(user_id)]}}).to_list(length=1000)
        for h in histories:
            if "userId" in h:
                h["userId"] = str(h["userId"])
        sound_dna = calculate_sound_dna(histories)
        
        total_seconds = sum(h.get("listenDuration", 30) for h in histories)
        total_minutes = round(total_seconds / 60)
        
        # Respect showTopSongs privacy setting
        show_top = user.get("settings", {}).get("showTopSongs", True)
        sorted_artists = []
        if show_top:
            # Top Artists
            artist_counts = {}
            for h in histories:
                artist = h.get("song", {}).get("artist", "Unknown Artist")
                thumbnail = h.get("song", {}).get("thumbnail", "")
                if artist:
                    artist_counts[artist] = artist_counts.get(artist, {"count": 0, "artist": artist, "thumbnail": thumbnail})
                    artist_counts[artist]["count"] += 1
            sorted_artists = sorted(artist_counts.values(), key=lambda x: x["count"], reverse=True)[:5]
        
        # Clean private user fields for security
        public_data = {
            "id": user_id,
            "username": user["username"],
            "displayName": user["displayName"],
            "avatar": user.get("avatar"),
            "theme": user.get("theme", "Obsidian"),
            "soundDNA": sound_dna,
            "totalMinutes": total_minutes,
            "topArtists": sorted_artists,
            "playlists": playlists,
            "memories": memories,
            "createdAt": user["createdAt"].isoformat() if "createdAt" in user else None
        }
        
        return {"success": True, "data": public_data}
    except Exception as e:
        logger.error(f"Error fetching public profile {username}: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/users/public/{username}")
async def get_users_public_profile(username: str):
    try:
        database = db.get_db()
        user = await database[db.USERS].find_one({"username": username.lower()})
        if not user:
            return {"success": False, "error": "User profile not found."}
            
        # Respect publicPassport privacy setting
        passport_enabled = user.get("settings", {}).get("publicPassport", True)
        if not passport_enabled:
            return {"success": False, "error": "This passport is set to private."}

        user_id = str(user["_id"])
        
        # Get public playlists
        playlists = await database[db.PLAYLISTS].find({"userId": {"$in": [user_id, ObjectId(user_id)]}, "visibility": "public"}).to_list(length=30)
        for p in playlists:
            p["id"] = str(p["_id"])
            p["userId"] = str(p["userId"])
            del p["_id"]
            if "createdAt" in p:
                p["createdAt"] = p["createdAt"].isoformat()
                
        # Get public memories
        memories = await database["songMemories"].find({"userId": {"$in": [user_id, ObjectId(user_id)]}, "visibility": "public"}).sort("createdAt", -1).to_list(length=20)
        for m in memories:
            m["id"] = str(m["_id"])
            m["userId"] = str(m["userId"])
            del m["_id"]
            if "date" in m:
                m["date"] = m["date"].isoformat()
            if "createdAt" in m:
                m["createdAt"] = m["createdAt"].isoformat()
                
        # Get stats
        histories = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": [user_id, ObjectId(user_id)]}}).to_list(length=1000)
        for h in histories:
            if "userId" in h:
                h["userId"] = str(h["userId"])
        sound_dna = calculate_sound_dna(histories)
        
        total_seconds = sum(h.get("listenDuration", 30) for h in histories)
        total_minutes = round(total_seconds / 60)
        
        # Calculate monthly seconds/minutes
        thirty_days_ago = datetime.utcnow() - timedelta(days=30)
        monthly_seconds = sum(h.get("listenDuration", 30) for h in histories if h.get("playedAt", datetime.utcnow()) >= thirty_days_ago)
        monthly_minutes = round(monthly_seconds / 60)
        
        # Respect showTopSongs privacy setting
        show_top = user.get("settings", {}).get("showTopSongs", True)
        sorted_artists = []
        sorted_songs = []
        if show_top:
            # Top Songs
            song_counts = {}
            for h in histories:
                song = h.get("song", {})
                vid = song.get("videoId")
                duration = song.get("duration", 180)
                if vid:
                    if vid not in song_counts:
                        song_counts[vid] = {
                            "title": song.get("title"),
                            "artist": song.get("artist"),
                            "image": song.get("thumbnail"),
                            "videoId": vid,
                            "plays": 0,
                            "minutes": 0,
                            "totalSeconds": 0,
                            "duration": duration
                        }
                    song_counts[vid]["totalSeconds"] += h.get("listenDuration", 0)
                    song_counts[vid]["minutes"] = round(song_counts[vid]["totalSeconds"] / 60)
            
            # Post-calculate song plays
            for vid, sc in song_counts.items():
                sc["plays"] = max(1, int(round(sc["totalSeconds"] / max(1, sc["duration"]))))
                # cleanup temp fields
                del sc["totalSeconds"]
                del sc["duration"]

            sorted_songs = sorted(song_counts.values(), key=lambda x: x["plays"], reverse=True)[:5]

            # Top Artists
            artist_counts = {}
            for h in histories:
                artist = h.get("song", {}).get("artist", "Unknown Artist")
                thumbnail = h.get("song", {}).get("thumbnail", "")
                if artist:
                    if artist not in artist_counts:
                        artist_counts[artist] = {
                            "artist": artist,
                            "thumbnail": thumbnail,
                            "count": 0,
                            "plays": 0
                        }
            # Sum up artist plays based on their songs' calculated plays
            for artist, ac in artist_counts.items():
                artist_plays = sum(s["plays"] for s in song_counts.values() if s.get("artist", "").lower() == artist.lower())
                ac["plays"] = max(1, artist_plays)
                ac["count"] = ac["plays"]

            sorted_artists = sorted(artist_counts.values(), key=lambda x: x["plays"], reverse=True)[:5]
        
        public_data = {
            "id": user_id,
            "username": user["username"],
            "displayName": user["displayName"],
            "avatar": user.get("avatar"),
            "bio": user.get("bio", ""),
            "passport": {
                "createdAt": user["createdAt"].isoformat() if "createdAt" in user else None,
                "theme": user.get("theme", "Obsidian"),
            },
            "soundDNA": sound_dna,
            "replayHighlights": {
                "totalMinutes": total_minutes,
                "monthlyMinutes": monthly_minutes,
            },
            "topArtists": sorted_artists,
            "topSongs": sorted_songs,
            "publicPlaylists": playlists,
            "memories": memories
        }
        
        return {"success": True, "data": public_data}
    except Exception as e:
        logger.error(f"Error fetching users public profile {username}: {str(e)}")
        return {"success": False, "error": str(e)}
