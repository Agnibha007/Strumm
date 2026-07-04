from fastapi import APIRouter, Depends, HTTPException, Body, Query
from typing import Optional, Dict, Any, List
from bson import ObjectId
from datetime import datetime, timedelta
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import SongSchema, UserSettingsSchema
from app.services.security import escaped_regex, parse_object_id, sanitize_positive_int, sanitize_text
from app.services.normalizer import canonical_artist, normalize_artist, classify_genre
from app.services.email_service import send_account_deleted_email
from pydantic import BaseModel
import asyncio
import logging
import math
logger = logging.getLogger("strumm-user")
router = APIRouter(tags=["user"])

# Helper to calculate sound DNA
def calculate_sound_dna(histories: List[Dict[str, Any]]) -> Dict[str, int]:
    """Calculate Sound DNA metrics from real listening patterns.
    
    All metrics are scaled 1-10 and represent actual listening behavior.
    Uses only REAL history (never simulated entries).
    """
    if not histories:
        return {
            "energy": 5,
            "discovery": 5,
            "nostalgia": 5,
            "variety": 5,
            "repeatRate": 5
        }
    
    total_listens = len(histories)
    total_minutes = sum(h.get("listenDuration", 0) for h in histories) / 60
    
    # Track metrics
    unique_songs = set()
    unique_artists = set()
    song_play_counts = {}  # videoId -> play count
    artist_play_counts = {}  # canonical_artist -> play count
    
    high_energy_count = 0
    low_energy_count = 0
    nostalgia_count = 0
    
    high_energy_keywords = {"funk", "remix", "dance", "rock", "hype", "party", "rap", "metal", "electronic", "techno", "edm"}
    low_energy_keywords = {"lo-fi", "sleep", "binaural", "serenity", "delta", "theta", "acoustic", "sad", "relax", "meditation", "ambient"}
    nostalgia_keywords = {"classic", "retro", "vintage", "old", "hemanta", "kishore", "lata", "ghazal", "90s", "80s", "70s"}
    
    for h in histories:
        song = h.get("song", {})
        title = str(song.get("title", "")).lower()
        artist = str(song.get("artist", "")).lower()
        vid = song.get("videoId")
        
        if vid:
            unique_songs.add(vid)
            song_play_counts[vid] = song_play_counts.get(vid, 0) + 1
        
        if artist:
            import re
            processed_artist = re.sub(r'\s+(?:&|feat\.?|ft\.?|and)\s+', ',', artist)
            artists_list = [a.strip() for a in processed_artist.split(',') if a.strip()]
            for single_art in artists_list:
                canonical_key = canonical_artist(single_art)
                if canonical_key:
                    unique_artists.add(single_art)
                    artist_play_counts[canonical_key] = artist_play_counts.get(canonical_key, 0) + 1
        
        # Energy assessment
        if any(kw in title or kw in artist for kw in high_energy_keywords):
            high_energy_count += 1
        if any(kw in title or kw in artist for kw in low_energy_keywords):
            low_energy_count += 1
        
        # Nostalgia assessment
        if any(kw in title or kw in artist for kw in nostalgia_keywords):
            nostalgia_count += 1
    
    # 1. Energy (1-10): Based on high vs low energy music ratio
    if high_energy_count + low_energy_count > 0:
        energy_ratio = high_energy_count / (high_energy_count + low_energy_count)
        energy_score = int(round(energy_ratio * 10))
    else:
        energy_score = 5  # Neutral if no energy keywords found
    energy_score = max(1, min(10, energy_score))
    
    # 2. Discovery (1-10): Artist diversity - higher = more diverse
    unique_artist_ratio = min(1.0, len(unique_artists) / max(1, total_listens / 5))
    discovery_score = int(round(unique_artist_ratio * 10))
    discovery_score = max(1, min(10, discovery_score))
    
    # 3. Nostalgia (1-10): Proportion of classic/retro music
    nostalgia_ratio = nostalgia_count / total_listens
    nostalgia_score = int(round(nostalgia_ratio * 10))
    nostalgia_score = max(1, min(10, nostalgia_score))
    
    # 4. Variety (1-10): Song diversity - higher = more variety
    unique_song_ratio = len(unique_songs) / max(1, total_listens)
    variety_score = int(round(unique_song_ratio * 10))
    variety_score = max(1, min(10, variety_score))
    
    # 5. Repeat Rate (1-10): How much user replays same songs (1=minimal repeats, 10=heavily repeated)
    if len(unique_songs) > 0:
        avg_plays_per_song = total_listens / len(unique_songs)
        # Map avg_plays_per_song to 1-10 scale:
        # 1 play per song = 1, 2 = ~3, 3 = ~4, 5 = ~6, 10 = ~8, 20+ = 10
        # Using logarithmic scale for natural distribution
        repeat_score = int(round(1 + 3 * math.log2(max(1, avg_plays_per_song))))
    else:
        repeat_score = 1
    repeat_score = max(1, min(10, repeat_score))
    
    return {
        "energy": energy_score,
        "discovery": discovery_score,
        "nostalgia": nostalgia_score,
        "variety": variety_score,
        "repeatRate": repeat_score
    }

def get_music_personality(histories: List[Dict[str, Any]], sound_dna: Dict[str, int]) -> str:
    """Classify the user's music personality from time-of-day patterns and Sound DNA.
    
    Uses all 5 DNA dimensions plus listening time for richer archetypes.
    """
    if not histories:
        return "Novice Listener"
    
    midnight_count = 0
    for h in histories:
        played_at = h.get("playedAt")
        if isinstance(played_at, datetime):
            hour = played_at.hour
            if 0 <= hour < 6:
                midnight_count += 1

    midnight_ratio = midnight_count / len(histories) if histories else 0

    energy = sound_dna.get("energy", 5)
    discovery = sound_dna.get("discovery", 5)
    nostalgia = sound_dna.get("nostalgia", 5)
    variety = sound_dna.get("variety", 5)
    repeat_rate = sound_dna.get("repeatRate", 5)

    # Late-night listener
    if midnight_ratio > 0.4:
        return "Midnight Explorer"

    # High energy + high variety = high-octane explorer
    if energy >= 7 and variety >= 7:
        return "Adrenaline Seeker"

    # High discovery + high variety = genre-hopping explorer
    if discovery >= 7 and variety >= 7:
        return "Sonic Pathfinder"

    # High repeat = creature of comfort
    if repeat_rate >= 7 and nostalgia >= 6:
        return "Memory Collector"

    # High nostalgia + low energy = vintage soul
    if nostalgia >= 7 and energy <= 4:
        return "Retro Archivist"

    # High energy + high repeat = playlist loyalist
    if energy >= 6 and repeat_rate >= 6:
        return "Power Anthem Lover"

    # High discovery + low repeat = fresh-chaser
    if discovery >= 6 and repeat_rate <= 3:
        return "New Release Hunter"

    # High variety + moderate everything = eclectic curator
    if variety >= 7:
        return "Eclectic Curator"

    # High nostalgia = classic soul
    if nostalgia >= 6:
        return "Retro Archivist"

    # High repeat = loyal listener
    if repeat_rate >= 6:
        return "Memory Collector"

    # High energy = vibe chaser
    if energy >= 6:
        return "Vibe Architect"

    return "Melody Harmonizer"


# Helper to get effective histories (merging actual playback history with seeded stats)
def get_effective_histories(histories: List[Dict[str, Any]], user_stats: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    effective = list(histories)
    if not user_stats:
        return effective
        
    top_artists = user_stats.get("topArtists") or []
    if not top_artists:
        return effective
        
    # Count plays per artist in actual histories
    actual_artist_counts = {}
    for h in histories:
        artist = h.get("song", {}).get("artist", "Unknown Artist")
        if artist:
            import re
            processed_artist = re.sub(r'\s+(?:&|feat\.?|ft\.?|and)\s+', ',', artist)
            artists_list = [a.strip().lower() for a in processed_artist.split(',') if a.strip()]
            for single_art in artists_list:
                actual_artist_counts[single_art] = actual_artist_counts.get(single_art, 0) + 1
                
    # Check each seeded artist, splitting multi-artist entries
    expanded_seeded_artists = {}
    for art in top_artists:
        artist_name = art.get("name") or art.get("artist") or ""
        if not artist_name:
            continue
        seeded_plays = art.get("playCount") or art.get("plays") or 0
        if seeded_plays <= 0:
            continue
            
        import re
        name_clean = artist_name.replace("&amp;", ",")
        split_names = [a.strip() for a in re.split(r'\s*(?:,|&|\bfeat\.?|\bft\.?|\band\b)\s*', name_clean, flags=re.IGNORECASE) if a.strip()]
        for split_name in split_names:
            key = split_name.lower()
            if key not in expanded_seeded_artists:
                expanded_seeded_artists[key] = {
                    "name": split_name,
                    "playCount": 0
                }
            expanded_seeded_artists[key]["playCount"] += seeded_plays

    for key, art_data in expanded_seeded_artists.items():
        artist_name = art_data["name"]
        seeded_plays = art_data["playCount"]
        
        actual_plays = actual_artist_counts.get(key, 0)
        missing_plays = seeded_plays - actual_plays
        
        if missing_plays > 0:
            # Generate simulated entries to match the seeded play count
            loops = min(150, missing_plays)
            for i in range(loops):
                title = "Classic Melody"
                top_songs = user_stats.get("topSongs") or []
                matching_songs = [s for s in top_songs if s.get("artist", "").lower() == artist_name.lower()]
                if matching_songs:
                    title = matching_songs[i % len(matching_songs)].get("title", "Classic Melody")
                else:
                    if any(x in artist_name.lower() for x in ["hemant", "mukherjee", "kishore", "lata"]):
                        title = "Classic Melody"
                    else:
                        title = "Hit Song"
                
                effective.append({
                    "song": {
                        "title": title,
                        "artist": artist_name,
                        "videoId": f"simulated-{artist_name}-{i}"
                    },
                    "listenDuration": 180,
                    "playedAt": datetime.utcnow().replace(hour=20, minute=0)
                })
                
    return effective

# Helper to calculate user stats dynamically
def compute_user_stats(histories: List[Dict[str, Any]], current_user_statistics: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Compute user stats from REAL playback histories only (no simulated data)."""
    # Always use real histories only - never inject simulated entries
    real_histories = histories

    # 1. Total & Monthly seconds — always computed from REAL history.
    #    Stored stats are only used as a fallback when no history exists
    #    (e.g. legacy/seeded accounts before playback histories were logged).
    total_seconds_hist = sum(h.get("listenDuration", 0) for h in real_histories)
    total_seconds_stored = (current_user_statistics or {}).get("totalListeningTime", 0) or 0

    if total_seconds_hist > 0:
        total_seconds = total_seconds_hist
    else:
        total_seconds = total_seconds_stored
    total_minutes = int(round(total_seconds / 60))

    thirty_days_ago = datetime.utcnow() - timedelta(days=30)
    monthly_seconds_hist = sum(
        h.get("listenDuration", 0)
        for h in real_histories
        if h.get("playedAt", datetime.utcnow()) >= thirty_days_ago
    )
    monthly_seconds_stored = (current_user_statistics or {}).get("monthlyListeningTime", 0) or 0

    if monthly_seconds_hist > 0:
        monthly_seconds = monthly_seconds_hist
    else:
        monthly_seconds = monthly_seconds_stored
    monthly_minutes = int(round(monthly_seconds / 60))
    
    # 2. Top Songs from REAL data
    song_counts = {}
    for h in real_histories:
        song = h.get("song", {})
        vid = song.get("videoId")
        duration = song.get("duration", 180) or 180
        if vid:
            if vid not in song_counts:
                song_counts[vid] = {
                    "title": song.get("title", "Unknown Track"),
                    "artist": song.get("artist", "Unknown Artist"),
                    "thumbnail": song.get("thumbnail", ""),
                    "image": song.get("thumbnail", ""),
                    "videoId": vid,
                    "plays": 0,
                    "minutes": 0,
                    "totalSeconds": 0,
                    "duration": duration
                }
            song_counts[vid]["totalSeconds"] += h.get("listenDuration", 0)
            
    # Post-calculate song plays
    for vid, sc in song_counts.items():
        sc["plays"] = max(1, int(round(sc["totalSeconds"] / max(1, sc["duration"]))))
        sc["count"] = sc["plays"]
        sc["minutes"] = int(round(sc["totalSeconds"] / 60))
        sc["totalMinutes"] = sc["minutes"]
        if "totalSeconds" in sc:
            del sc["totalSeconds"]
            
    # Ignore simulated songs from sorted_songs list
    real_song_counts = {vid: sc for vid, sc in song_counts.items() if not vid.startswith("simulated-")}
    sorted_songs = sorted(real_song_counts.values(), key=lambda x: x["plays"], reverse=True)[:5]
    if not sorted_songs and user_stats.get("topSongs"):
        sorted_songs = user_stats.get("topSongs")
    
    # 3. Top Artists from REAL data — grouped by canonicalArtist to prevent duplicates
    #    e.g. "Arijit Singh", "ARIJIT SINGH", "Arijit Singh Official" all collapse
    #    under the same canonical key.  The most-played display name wins.
    canonical_groups: dict = {}
    for h in real_histories:
        artist = h.get("song", {}).get("artist", "Unknown Artist")
        thumbnail = h.get("song", {}).get("thumbnail", "")
        if artist:
            import re
            processed_artist = re.sub(r'\s+(?:&|feat\.?|ft\.?|and)\s+', ',', artist)
            artists_list = [a.strip() for a in processed_artist.split(',') if a.strip()]
            for single_art in artists_list:
                canonical_key = canonical_artist(single_art)
                if not canonical_key:
                    continue
                if canonical_key not in canonical_groups:
                    canonical_groups[canonical_key] = {
                        "artist": single_art,
                        "thumbnail": thumbnail,
                        "image": thumbnail,
                        "count": 0,
                        "plays": 0,
                        "minutes": 0,
                        "totalSeconds": 0,
                        "display_name": single_art,
                        "name_counts": {single_art.lower(): 1},
                    }
                else:
                    # Track display name frequencies — most common wins
                    name_lower = single_art.lower()
                    group = canonical_groups[canonical_key]
                    group["name_counts"][name_lower] = group["name_counts"].get(name_lower, 0) + 1
                    # Update display name if this variant is more common
                    if group["name_counts"][name_lower] > group["name_counts"].get(group["display_name"].lower(), 0):
                        group["display_name"] = single_art
                    # Keep the best thumbnail
                    if thumbnail and not group["thumbnail"]:
                        group["thumbnail"] = thumbnail
                        group["image"] = thumbnail
                canonical_groups[canonical_key]["totalSeconds"] += h.get("listenDuration", 0)
                
    # Sum up artist plays based on their songs' calculated plays
    for canonical_key, ac in canonical_groups.items():
        import re
        artist_plays = 0
        for s in song_counts.values():
            song_artist = s.get("artist", "")
            if song_artist:
                song_artists_list = [sa.strip().lower() for sa in re.sub(r'\s+(?:&|feat\.?|ft\.?|and)\s+', ',', song_artist).split(',') if sa.strip()]
                # Match against canonical artist
                for sa in song_artists_list:
                    if canonical_artist(sa) == canonical_key:
                        artist_plays += s["plays"]
                        break
        ac["plays"] = max(1, artist_plays)
        ac["count"] = ac["plays"]
        ac["artist"] = ac["display_name"]  # Use best display name
        ac["minutes"] = int(round(ac["totalSeconds"] / 60))
        # Remove internal tracking fields
        for field in ["totalSeconds", "display_name", "name_counts"]:
            ac.pop(field, None)
            
    sorted_artists = sorted(canonical_groups.values(), key=lambda x: x["plays"], reverse=True)[:5]
    if not sorted_artists and user_stats.get("topArtists"):
        sorted_artists = []
        for art in user_stats.get("topArtists"):
            sorted_artists.append({
                "artist": art.get("name", "Unknown Artist"),
                "plays": art.get("playCount", 0),
                "count": art.get("playCount", 0),
                "thumbnail": "",
                "image": ""
            })
    
    # Ensure canonicalName is set for all entries (backward compat with legacy data)
    for art in sorted_artists:
        if not art.get("canonicalName"):
            art["canonicalName"] = canonical_artist(art.get("artist", ""))
            
    # 4. Sound DNA — always calculated from REAL histories only
    # Never use simulated entries - sound DNA must reflect actual listening patterns
    sound_dna = calculate_sound_dna(real_histories)
    
    return {
        "totalListeningTime": total_seconds,
        "monthlyListeningTime": monthly_seconds,
        "totalMinutes": total_minutes,
        "monthlyMinutes": monthly_minutes,
        "topSongs": sorted_songs,
        "topArtists": sorted_artists,
        "soundDNA": sound_dna
    }

# User Profile
@router.get("/profile")
async def get_profile(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        user_id_str = current_user["id"]
        possible_ids = [user_id_str]
        if ObjectId.is_valid(user_id_str):
            possible_ids.append(ObjectId(user_id_str))
            
        histories = await database[db.PLAYBACK_HISTORIES].find(
            {"userId": {"$in": possible_ids}},
            {"song": 1, "listenDuration": 1, "playedAt": 1, "_id": 0}
        ).to_list(length=2000)
        stats = compute_user_stats(histories, current_user.get("statistics"))
        user_data = dict(current_user)
        user_data["soundDNA"] = stats["soundDNA"]
        user_data["statistics"] = {
            "totalListeningTime": stats["totalListeningTime"],
            "monthlyListeningTime": stats["monthlyListeningTime"],
            "topArtists": stats["topArtists"],
            "topSongs": stats["topSongs"]
        }
        return {
            "success": True,
            "data": user_data
        }
    except Exception as e:
        import traceback
        logger.error(f"Error calculating soundDNA for profile: {e}\n{traceback.format_exc()}")
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
    username: Optional[str] = Body(None),
    avatar: Optional[str] = Body(None),
    theme: Optional[str] = Body(None),
    settings: Optional[UserSettingsSchema] = Body(None),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        update_data = {}
        if username is not None:
            cleaned_username = sanitize_text(username, max_length=50).strip().lower()
            if not cleaned_username:
                return {"success": False, "error": "Username cannot be empty."}
            import re
            if not re.match(r"^[a-z0-9_-]+$", cleaned_username):
                return {"success": False, "error": "Username can only contain lowercase letters, numbers, underscores, and dashes."}
            existing = await database[db.USERS].find_one({
                "username": cleaned_username,
                "_id": {"$ne": parse_object_id(current_user["id"])}
            })
            if existing:
                return {"success": False, "error": "Username is already taken by another user."}
            update_data["username"] = cleaned_username

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
    import traceback
    user_id_str = current_user["id"]
    logger.debug(f"[/library] Authenticated User ID: {user_id_str}")
    try:
        database = db.get_db()
        possible_ids = [user_id_str]
        if ObjectId.is_valid(user_id_str):
            possible_ids.append(ObjectId(user_id_str))
            
        mongo_query = {"userId": {"$in": possible_ids}}
        logger.debug(f"[/library] Mongo Query for Playlists: {mongo_query}")
        
        # 1. Playlists
        playlists_cursor = database[db.PLAYLISTS].find(mongo_query)
        playlists = []
        async for doc in playlists_cursor:
            doc["_id"] = str(doc["_id"])
            doc["id"] = str(doc["_id"])
            doc["userId"] = str(doc["userId"])
            playlists.append(doc)
            
        playlist_count = len(playlists)
        logger.debug(f"[/library] Playlist count: {playlist_count}")
        
        # 2. Liked Songs Count
        liked_query = {"userId": {"$in": possible_ids}}
        liked_count = await database[db.LIKED_SONGS].count_documents(liked_query)
        logger.debug(f"[/library] Liked songs count: {liked_count}")
        
        return {
            "success": True,
            "data": {
                "playlists": playlists,
                "likedSongsCount": liked_count
            }
        }
    except Exception as e:
        tb_str = traceback.format_exc()
        logger.error(f"[/library] Exception traceback:\n{tb_str}")
        logger.error(f"Error fetching library: {str(e)}\n{tb_str}")
        return {"success": False, "error": f"Failed to fetch library: {str(e)}", "traceback": tb_str}

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
        pipeline = [
            {"$match": {"userId": {"$in": [user_id_str, user_id_oid]}}},
            {"$sort": {"playedAt": -1}},
            {
                "$group": {
                    "_id": {
                        "$cond": [
                            {"$and": [{"$ne": ["$song.videoId", None]}, {"$ne": ["$song.videoId", ""]}]},
                            "$song.videoId",
                            {"$concat": ["$song.title", " - ", "$song.artist"]}
                        ]
                    },
                    "latest_doc": {"$first": "$$ROOT"}
                }
            },
            {"$replaceRoot": {"newRoot": "$latest_doc"}},
            {"$sort": {"playedAt": -1}},
            {"$limit": limit}
        ]
        cursor = database[db.PLAYBACK_HISTORIES].aggregate(pipeline)
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
        await database[db.USERS].update_one(
            {"_id": user_id_oid},
            {"$set": {
                "statistics.totalListeningTime": 0,
                "statistics.monthlyListeningTime": 0,
                "statistics.topArtists": [],
                "statistics.topSongs": [],
                "soundDNA": {
                    "energy": 5,
                    "discovery": 5,
                    "nostalgia": 5,
                    "variety": 5,
                    "repeatRate": 5
                }
            }}
        )
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
        
        # 2. Update user statistics (totalListeningTime only)
        # monthlyListeningTime is computed dynamically from history (30-day window)
        # by compute_user_stats, so we only persist totalListeningTime here.
        await database[db.USERS].update_one(
            {"_id": parse_object_id(userId)},
            {"$inc": {"statistics.totalListeningTime": duration_delta}}
        )
        
        # Async updates of top artists (splitting multiple artists)
        artist_name = song_dict.get("artist", "")
        if artist_name:
            # Check if artist is already tracked in user statistics
            user_doc = await database[db.USERS].find_one({"_id": parse_object_id(userId)})
            top_artists = user_doc.get("statistics", {}).get("topArtists", [])
            
            # Clean and split multiple artists
            import re
            name_clean = artist_name.replace("&amp;", ",")
            split_names = [a.strip() for a in re.split(r'\s*(?:,|&|\bfeat\.?|\bft\.?|\band\b)\s*', name_clean, flags=re.IGNORECASE) if a.strip()]
            
            # Update play counts for each artist separately
            # Group artists by canonical key to prevent duplicates
            for single_art in split_names:
                art_canonical = canonical_artist(single_art)
                if not art_canonical:
                    continue
                found = False
                for art in top_artists:
                    existing_canonical = art.get("canonicalName") or canonical_artist(art.get("name", ""))
                    if existing_canonical == art_canonical:
                        art["playCount"] = art.get("playCount", 0) + 1
                        # Update display name if a better variant appears
                        art["name"] = normalize_artist(single_art)
                        art["canonicalName"] = art_canonical
                        found = True
                        break
                if not found:
                    top_artists.append({
                        "name": normalize_artist(single_art),
                        "canonicalName": art_canonical,
                        "playCount": 1
                    })
                
            # Limit top artists to top 10 sorted by playCount
            top_artists = sorted(top_artists, key=lambda x: x.get("playCount", 0), reverse=True)[:10]
            
            await database[db.USERS].update_one(
                {"_id": parse_object_id(userId)},
                {"$set": {"statistics.topArtists": top_artists}}
            )

        # 3. Handle podcast listening badges
        is_podcast = song_dict.get("videoId", "").startswith("podcast-")
        if is_podcast:
            episode_id = song_dict["videoId"].replace("podcast-", "")
            
            # Fetch episode details from DB to find showId
            episode_doc = None
            if ObjectId.is_valid(episode_id):
                episode_doc = await database[db.PODCAST_EPISODES].find_one({"_id": ObjectId(episode_id)})
            
            if episode_doc:
                show_id = episode_doc.get("showId")
                
                # Fetch all histories for this user that are podcasts
                possible_ids = [str(userId), userId]
                user_histories = await database[db.PLAYBACK_HISTORIES].find({
                    "userId": {"$in": possible_ids},
                    "song.videoId": {"$regex": "^podcast-"}
                }).to_list(length=1000)
                
                # Count unique episodes listened to
                unique_episode_vids = {h["song"]["videoId"] for h in user_histories if h.get("song", {}).get("videoId")}
                # Make sure current videoId is counted
                unique_episode_vids.add(song_dict["videoId"])
                
                # Check user document for existing badges list
                user_doc = await database[db.USERS].find_one({"_id": parse_object_id(userId)})
                existing_badges = user_doc.get("badges", []) if user_doc else []
                existing_badge_ids = {b["id"] for b in existing_badges}
                
                new_badges = []
                
                # First podcast episode: "Podcast Pioneer"
                if len(unique_episode_vids) >= 1 and "podcast-first" not in existing_badge_ids:
                    new_badges.append({
                        "id": "podcast-first",
                        "title": "Podcast Pioneer",
                        "description": "Listened to your first podcast episode.",
                        "icon": "🎙️",
                        "earnedAt": datetime.utcnow().isoformat()
                    })
                
                # Fifth podcast episode: "Podcast Devotee"
                if len(unique_episode_vids) >= 5 and "podcast-fifth" not in existing_badge_ids:
                    new_badges.append({
                        "id": "podcast-fifth",
                        "title": "Podcast Devotee",
                        "description": "Listened to 5 podcast episodes.",
                        "icon": "🎧",
                        "earnedAt": datetime.utcnow().isoformat()
                    })
                
                # Every episode of a podcast: "Completist"
                if show_id:
                    show_episodes = await database[db.PODCAST_EPISODES].find({"showId": show_id}).to_list(length=1000)
                    show_episode_vids = {f"podcast-{str(ep['_id'])}" for ep in show_episodes}
                    
                    if show_episode_vids:
                        show_doc = await database[db.PODCAST_SHOWS].find_one({"_id": parse_object_id(show_id)})
                        show_title = show_doc.get("title", "this podcast") if show_doc else "this podcast"
                        completist_badge_id = f"podcast-completist-{show_id}"
                        
                        if show_episode_vids.issubset(unique_episode_vids) and completist_badge_id not in existing_badge_ids:
                            new_badges.append({
                                "id": completist_badge_id,
                                "title": f"{show_title} Completist",
                                "description": f"Listened to every episode of '{show_title}'.",
                                "icon": "🏆",
                                "earnedAt": datetime.utcnow().isoformat()
                            })
                            
                if new_badges:
                    await database[db.USERS].update_one(
                        {"_id": parse_object_id(userId)},
                        {"$push": {"badges": {"$each": new_badges}}}
                    )

        # 4. Fire-and-forget: recalculate full stats (soundDNA, topSongs, topArtists)
        # in background so they're always fresh when the user visits Replay or Profile.
        asyncio.create_task(recalculate_user_stats_and_save(str(userId)))

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

        # Update/delete direct listening activities to reflect real-time playing state
        show_act = current_user.get("settings", {}).get("showListeningActivity", True)
        if show_act:
            if payload.isPlaying and payload.currentSong:
                await database["activities"].update_one(
                    {"userId": current_user["id"]},
                    {"$set": {
                        "userId": current_user["id"],
                        "type": "listening",
                        "song": payload.currentSong.model_dump(),
                        "timestamp": datetime.utcnow(),
                        "expiresAt": datetime.utcnow() + timedelta(minutes=2)
                    }},
                    upsert=True
                )
            else:
                await database["activities"].delete_one({"userId": current_user["id"], "type": "listening"})
        else:
            await database["activities"].delete_one({"userId": current_user["id"], "type": "listening"})

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
        
        possible_ids = [user_id, oid]
        
        # Delete user playlists
        await database[db.PLAYLISTS].delete_many({"userId": {"$in": possible_ids}})
        
        # Delete user liked songs
        await database[db.LIKED_SONGS].delete_many({"userId": {"$in": possible_ids}})
        
        # Delete user history
        await database[db.PLAYBACK_HISTORIES].delete_many({"userId": {"$in": possible_ids}})
        
        # Delete user player state
        await database[db.PLAYER_STATES].delete_many({"userId": {"$in": possible_ids}})
        
        # Delete user share tokens
        await database[db.SHARES].delete_many({"userId": {"$in": possible_ids}})
        
        # Delete user follows
        await database["follows"].delete_many({"userId": user_id})
        
        # Delete user memories
        await database["songMemories"].delete_many({"userId": user_id})
        
        # Notify via email in background before returning
        asyncio.create_task(send_account_deleted_email(current_user.get("email", "")))

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

async def recalculate_user_stats_and_save(user_id: str) -> None:
    """Recalculate a single user's stats from raw playback histories and save to their document."""
    import asyncio
    try:
        database = db.get_db()
        possible_ids = [user_id]
        if ObjectId.is_valid(user_id):
            possible_ids.append(ObjectId(user_id))
        histories = await database[db.PLAYBACK_HISTORIES].find(
            {"userId": {"$in": possible_ids}},
            {"song": 1, "listenDuration": 1, "playedAt": 1, "_id": 0}
        ).to_list(length=2000)
        
        # Fetch current user to get seeded statistics
        user_doc = await database[db.USERS].find_one({"_id": parse_object_id(user_id)})
        if not user_doc:
            return
        
        stats = compute_user_stats(histories, user_doc.get("statistics"))
        
        await database[db.USERS].update_one(
            {"_id": parse_object_id(user_id)},
            {"$set": {
                "soundDNA": stats["soundDNA"],
                "statistics.totalListeningTime": stats["totalListeningTime"],
                "statistics.monthlyListeningTime": stats["monthlyListeningTime"],
                "statistics.topArtists": stats["topArtists"],
                "statistics.topSongs": stats["topSongs"]
            }}
        )
    except Exception as ex:
        logger.error(f"Failed to recalculate stats for user {user_id}: {ex}")

@router.post("/profile/recalculate")
async def recalculate_user_stats(current_user: dict = Depends(get_current_user)):
    try:
        database = db.get_db()
        user_id_str = current_user["id"]
        possible_ids = [user_id_str]
        if ObjectId.is_valid(user_id_str):
            possible_ids.append(ObjectId(user_id_str))
            
        histories = await database[db.PLAYBACK_HISTORIES].find(
            {"userId": {"$in": possible_ids}},
            {"song": 1, "listenDuration": 1, "playedAt": 1, "_id": 0}
        ).to_list(length=2000)
        stats = compute_user_stats(histories, current_user.get("statistics"))
        
        # Save to database
        await database[db.USERS].update_one(
            {"_id": parse_object_id(user_id_str)},
            {"$set": {
                "soundDNA": stats["soundDNA"],
                "statistics.totalListeningTime": stats["totalListeningTime"],
                "statistics.monthlyListeningTime": stats["monthlyListeningTime"],
                "statistics.topArtists": stats["topArtists"],
                "statistics.topSongs": stats["topSongs"]
            }}
        )
        
        # Also return updated profile representation
        user_data = dict(current_user)
        user_data["soundDNA"] = stats["soundDNA"]
        user_data["statistics"] = {
            "totalListeningTime": stats["totalListeningTime"],
            "monthlyListeningTime": stats["monthlyListeningTime"],
            "topArtists": stats["topArtists"],
            "topSongs": stats["topSongs"]
        }
        
        return {
            "success": True,
            "message": "Sound DNA and statistics recalculated and synced successfully.",
            "data": user_data
        }
    except Exception as e:
        logger.error(f"Error recalculating user statistics live: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/profile/export")
async def export_user_data(current_user: dict = Depends(get_current_user)):
    """Export all user data for GDPR compliance."""
    try:
        database = db.get_db()
        user_id = current_user["id"]
        possible_ids = [user_id, parse_object_id(user_id)]
        
        # Profile
        user_data = dict(current_user)
        if "_id" in user_data:
            del user_data["_id"]
        if "password" in user_data:
            del user_data["password"]
        
        # Playlists
        playlists = []
        async for p in database[db.PLAYLISTS].find({"userId": {"$in": possible_ids}}):
            p["id"] = str(p["_id"])
            del p["_id"]
            playlists.append(p)
        
        # Liked songs
        liked = []
        async for l in database[db.LIKED_SONGS].find({"userId": {"$in": possible_ids}}):
            l["id"] = str(l["_id"])
            del l["_id"]
            liked.append(l)
        
        # History
        history = []
        async for h in database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_ids}}).sort("playedAt", -1).limit(1000):
            h["id"] = str(h["_id"])
            del h["_id"]
            if "userId" in h:
                h["userId"] = str(h["userId"])
            history.append(h)
        
        # Memories
        memories = []
        async for m in database["songMemories"].find({"userId": {"$in": possible_ids}}).sort("createdAt", -1):
            m["id"] = str(m["_id"])
            del m["_id"]
            memories.append(m)
        
        return {
            "success": True,
            "data": {
                "exportedAt": datetime.utcnow().isoformat(),
                "profile": user_data,
                "playlists": playlists,
                "likedSongs": liked,
                "listeningHistory": history,
                "memories": memories,
                "totalPlaylists": len(playlists),
                "totalLikedSongs": len(liked),
                "totalHistoryEntries": len(history),
                "totalMemories": len(memories),
            }
        }
    except Exception as e:
        logger.error(f"Error exporting user data: {str(e)}")
        return {"success": False, "error": "Failed to export data."}


@router.get("/replay")
async def get_replay(current_user: dict = Depends(get_current_user)):
    """Get user's replay statistics (Strumm Wrapped equivalent).
    
    Always calculates from REAL playback history - never uses simulated data.
    All metrics are dynamic and coherent.
    """
    try:
        database = db.get_db()
        user_id = current_user["id"]
        possible_ids = [user_id, parse_object_id(user_id)]
        
        # Fetch ONLY real playback histories
        histories = await database[db.PLAYBACK_HISTORIES].find(
            {"userId": {"$in": possible_ids}},
            {"song": 1, "listenDuration": 1, "playedAt": 1, "_id": 0}
        ).to_list(length=2000)
        
        # Calculate all stats from REAL data with stored stats as fallback
        stats = compute_user_stats(histories, current_user.get("statistics"))
        
        personality = get_music_personality(histories, stats["soundDNA"])
        discovery_score = stats["soundDNA"]["discovery"] * 10
        insufficient_history = stats["totalMinutes"] < 1
        
        # Mapped top genres - from REAL data only
        genres = {}
        for h in histories:
            title = str(h.get("song", {}).get("title", "")).lower()
            artist = str(h.get("song", {}).get("artist", "")).lower()
            genre = classify_genre(artist, title)
            genres[genre] = genres.get(genre, 0) + 1
            
        sorted_genres = sorted(genres.items(), key=lambda x: x[1], reverse=True)[:3]
        top_genres = [g[0] for g in sorted_genres] if sorted_genres else ["Pop & Indie"]
        
        # Favorite Time - from REAL data only
        time_slots = {"Morning (6AM-12PM)": 0, "Afternoon (12PM-6PM)": 0, "Evening (6PM-12AM)": 0, "Midnight (12AM-6AM)": 0}
        for h in histories:
            played_at = h.get("playedAt")
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
        favorite_time = max(time_slots, key=time_slots.get) if histories else "Evening (6PM-12AM)"
        
        return {
            "success": True,
            "data": {
                "totalMinutes": stats["totalMinutes"],
                "topSongs": stats["topSongs"],
                "topArtists": stats["topArtists"],
                "topGenres": top_genres,
                "favoriteTime": favorite_time,
                "discoveryScore": discovery_score,
                "personality": personality,
                "soundDNA": stats["soundDNA"],
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
            
        # Get histories and likes using both string and ObjectId to avoid type mismatches
        possible_my_ids = [my_id]
        if ObjectId.is_valid(my_id):
            possible_my_ids.append(ObjectId(my_id))
            
        possible_their_ids = [user_id]
        if ObjectId.is_valid(user_id):
            possible_their_ids.append(ObjectId(user_id))
            
        my_histories = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_my_ids}}).to_list(length=1000)
        their_histories = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_their_ids}}).to_list(length=1000)
        
        my_likes = await database[db.LIKED_SONGS].find({"userId": {"$in": possible_my_ids}}).to_list(length=1000)
        their_likes = await database[db.LIKED_SONGS].find({"userId": {"$in": possible_their_ids}}).to_list(length=1000)
        
        # Populate artists (case-insensitive) and song videoIds
        my_artists = set()
        my_songs = set()
        for h in my_histories:
            s = h.get("song", {})
            if s.get("artist"):
                my_artists.add(str(s["artist"]).strip().lower())
            if s.get("videoId"):
                my_songs.add(str(s["videoId"]))
        for l in my_likes:
            s = l.get("song", {})
            if s.get("artist"):
                my_artists.add(str(s["artist"]).strip().lower())
            if s.get("videoId"):
                my_songs.add(str(s["videoId"]))
                
        their_artists = set()
        their_songs = set()
        for h in their_histories:
            s = h.get("song", {})
            if s.get("artist"):
                their_artists.add(str(s["artist"]).strip().lower())
            if s.get("videoId"):
                their_songs.add(str(s["videoId"]))
        for l in their_likes:
            s = l.get("song", {})
            if s.get("artist"):
                their_artists.add(str(s["artist"]).strip().lower())
            if s.get("videoId"):
                their_songs.add(str(s["videoId"]))
        
        common_artists = list(my_artists.intersection(their_artists))
        common_songs_ids = my_songs.intersection(their_songs)
        
        # Get common song details for display
        common_songs = []
        found_song_vids = set()
        for item in (my_histories + my_likes):
            s = item.get("song", {})
            vid = s.get("videoId")
            if vid in common_songs_ids and vid not in found_song_vids:
                common_songs.append(s.get("title"))
                found_song_vids.add(vid)
                if len(common_songs) >= 5:
                    break
                
        # Calculate matching percentage using overlap coefficient
        if not my_songs and not their_songs:
            match_percentage = 50  # Neutral default for no data
        else:
            min_artist_len = min(len(my_artists), len(their_artists))
            artist_similarity = len(common_artists) / max(1, min_artist_len) if min_artist_len > 0 else 0
            
            min_song_len = min(len(my_songs), len(their_songs))
            song_similarity = len(common_songs_ids) / max(1, min_song_len) if min_song_len > 0 else 0
            
            # Scale compatibility percentage between 35% and 98%
            match_percentage = int(round(35 + 35 * artist_similarity + 28 * song_similarity))
            match_percentage = max(15, min(98, match_percentage))
        
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

# --- User Search (for Profiles filter in search page) ---

@router.get("/users/search")
async def search_users(
    q: str = Query(..., min_length=1, description="Search query for display name"),
    limit: int = Query(6, ge=1, le=20)
):
    """Search public user profiles by display name. No auth required."""
    try:
        database = db.get_db()
        cleaned_query = sanitize_text(q, max_length=120)
        regex_query = escaped_regex(cleaned_query)
        user_cursor = database[db.USERS].find(
            {"displayName": regex_query, "settings.privacy": "public"},
            {"displayName": 1, "username": 1, "avatar": 1, "theme": 1},
        ).limit(limit)

        users = []
        async for u in user_cursor:
            users.append({
                "id": str(u["_id"]),
                "displayName": u.get("displayName"),
                "username": u.get("username"),
                "avatar": u.get("avatar"),
            })

        return {"success": True, "data": users}
    except Exception as e:
        logger.error(f"User search failed: {str(e)}")
        return {"success": True, "data": []}

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
        histories = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": [user_id, ObjectId(user_id)]}}).to_list(length=2000)
        for h in histories:
            if "userId" in h:
                h["userId"] = str(h["userId"])
                
        stats = compute_user_stats(histories, user.get("statistics"))
        
        # Respect showTopSongs privacy setting
        show_top = user.get("settings", {}).get("showTopSongs", True)
        sorted_artists = stats["topArtists"] if show_top else []
        
        # Clean private user fields for security
        public_data = {
            "id": user_id,
            "username": user["username"],
            "displayName": user["displayName"],
            "avatar": user.get("avatar"),
            "theme": user.get("theme", "Obsidian"),
            "soundDNA": stats["soundDNA"],
            "totalMinutes": stats["totalMinutes"],
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
        histories = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": [user_id, ObjectId(user_id)]}}).to_list(length=2000)
        for h in histories:
            if "userId" in h:
                h["userId"] = str(h["userId"])
                
        stats = compute_user_stats(histories, user.get("statistics"))
        
        # Get liked count
        liked_count = await database[db.LIKED_SONGS].count_documents({"userId": {"$in": [user_id, ObjectId(user_id)]}})
        
        # Respect showTopSongs privacy setting
        show_top = user.get("settings", {}).get("showTopSongs", True)
        sorted_artists = stats["topArtists"] if show_top else []
        sorted_songs = stats["topSongs"] if show_top else []
        
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
            "soundDNA": stats["soundDNA"],
            "replayHighlights": {
                "totalMinutes": stats["totalMinutes"],
                "monthlyMinutes": stats["monthlyMinutes"],
            },
            "likedCount": liked_count,
            "topArtists": sorted_artists,
            "topSongs": sorted_songs,
            "publicPlaylists": playlists,
            "memories": memories
        }
        
        return {"success": True, "data": public_data}
    except Exception as e:
        logger.error(f"Error fetching users public profile {username}: {str(e)}")
        return {"success": False, "error": str(e)}
