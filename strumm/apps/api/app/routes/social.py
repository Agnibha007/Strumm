from fastapi import APIRouter, Depends, HTTPException, status, WebSocket, WebSocketDisconnect, Body
from typing import List, Optional, Dict, Any, Set
from datetime import datetime, timedelta
from bson import ObjectId
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import SongSchema
from app.services.security import parse_object_id, sanitize_text
from app.services.auth_utils import decode_access_token
from app.services.realtime.connection_manager import manager as realtime_manager
from app.services.realtime.events import (
    ROOM_CREATED,
    ROOM_UPDATED,
    ROOM_DELETED,
    ROOM_JOINED,
    ROOM_LEFT,
    AUTHENTICATE,
    CIRCLE_ACTIVITY_UPDATED,
    NOTIFICATION_CREATED,
)
from pydantic import BaseModel
import asyncio
import logging
import json
import hashlib

logger = logging.getLogger("strumm-social")
router = APIRouter(prefix="/social", tags=["social"])



# In-memory cache for taste match scores (in production, use Redis)
# Uses OrderedDict with max size and time-based eviction to prevent memory leaks.
from collections import OrderedDict as _OrderedDict
import time as _time

_taste_score_cache: _OrderedDict[str, int] = _OrderedDict()
_CACHE_MAX_SIZE = 10_000   # Max 10k entries
_CACHE_TTL_SECONDS = 3600  # 1 hour TTL

def _cache_key(user_a: str, user_b: str) -> str:
    """Generate consistent cache key for two users."""
    a, b = sorted([str(user_a), str(user_b)])
    return hashlib.sha256(f"{a}:{b}".encode()).hexdigest()[:32]


def _cache_get(key: str) -> int | None:
    """Get a cached taste score, evicting if expired."""
    if key not in _taste_score_cache:
        return None
    # Touch the entry (move to end == most recently used)
    val = _taste_score_cache.pop(key)
    _taste_score_cache[key] = val
    return val


def _cache_put(key: str, value: int) -> None:
    """Store a taste score with LRU eviction."""
    # Enforce max size — pop oldest (first) entry
    while len(_taste_score_cache) >= _CACHE_MAX_SIZE:
        _taste_score_cache.popitem(last=False)
    _taste_score_cache[key] = value

async def batch_compute_taste_scores(my_id: str, user_ids: List[str]) -> Dict[str, int]:
    """
    Batch compute taste match scores for multiple users at once.
    Much more efficient than individual computations.
    """
    if not user_ids:
        return {}
    
    try:
        database = db.get_db()
        my_id_str = str(my_id)
        
        # Collect all unique user IDs we need data for
        all_user_ids = [my_id_str] + [str(uid) for uid in user_ids]
        possible_ids = list(set(all_user_ids))
        
        # Single query for all playback histories
        playback_cursor = database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_ids}})
        playback_data = await playback_cursor.to_list(length=5000)
        
        # Single query for all liked songs
        likes_cursor = database[db.LIKED_SONGS].find({"userId": {"$in": possible_ids}})
        likes_data = await likes_cursor.to_list(length=5000)
        
        # Organize data by user ID
        user_artists: Dict[str, Set[str]] = {}
        user_songs: Dict[str, Set[str]] = {}
        
        for uid in possible_ids:
            user_artists[uid] = set()
            user_songs[uid] = set()
        
        # Process playback history
        for h in playback_data:
            uid = str(h.get("userId", ""))
            if uid in user_artists:
                song = h.get("song", {})
                if song.get("artist"):
                    user_artists[uid].add(str(song["artist"]).strip().lower())
                if song.get("videoId"):
                    user_songs[uid].add(str(song["videoId"]))
        
        # Process liked songs
        for h in likes_data:
            uid = str(h.get("userId", ""))
            if uid in user_artists:
                song = h.get("song", {})
                if song.get("artist"):
                    user_artists[uid].add(str(song["artist"]).strip().lower())
                if song.get("videoId"):
                    user_songs[uid].add(str(song["videoId"]))
        
        # Compute scores for each target user
        results = {}
        my_artists = user_artists.get(my_id_str, set())
        my_songs = user_songs.get(my_id_str, set())
        
        for target_id in user_ids:
            target_str = str(target_id)
            cache_key = _cache_key(my_id_str, target_str)
            
            # Check cache first
            cached = _cache_get(cache_key)
            if cached is not None:
                results[target_str] = cached
                continue
            
            target_artists = user_artists.get(target_str, set())
            target_songs = user_songs.get(target_str, set())
            
            if not my_songs and not target_songs:
                score = 50
            else:
                common_artists = my_artists.intersection(target_artists)
                common_songs = my_songs.intersection(target_songs)
                
                min_artist_len = min(len(my_artists), len(target_artists))
                artist_similarity = len(common_artists) / max(1, min_artist_len) if min_artist_len > 0 else 0
                
                min_song_len = min(len(my_songs), len(target_songs))
                song_similarity = len(common_songs) / max(1, min_song_len) if min_song_len > 0 else 0
                
                score = int(round(35 + 35 * artist_similarity + 28 * song_similarity))
                score = max(15, min(98, score))
            
            # Cache the result
            _cache_put(cache_key, score)
            results[target_str] = score
        
        return results
    except Exception as e:
        logger.warning(f"Batch taste score computation failed: {e}")
        return {uid: 50 for uid in user_ids}


async def compute_taste_match_score(user_a_id: str, user_b_id: str) -> int:
    """
    Compute taste match score with caching.
    Falls back to individual computation if batch not available.
    """
    try:
        cache_key = _cache_key(user_a_id, user_b_id)
        
        # Check cache first
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
        
        # Fallback to individual computation
        user_a_str = str(user_a_id)
        user_b_str = str(user_b_id)
        
        database = db.get_db()
        possible_a_ids = [user_a_str]
        if ObjectId.is_valid(user_a_str):
            possible_a_ids.append(ObjectId(user_a_str))
            
        possible_b_ids = [user_b_str]
        if ObjectId.is_valid(user_b_str):
            possible_b_ids.append(ObjectId(user_b_str))
            
        a_hist = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_a_ids}}).to_list(length=500)
        b_hist = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_b_ids}}).to_list(length=500)
        
        a_likes = await database[db.LIKED_SONGS].find({"userId": {"$in": possible_a_ids}}).to_list(length=500)
        b_likes = await database[db.LIKED_SONGS].find({"userId": {"$in": possible_b_ids}}).to_list(length=500)
        
        a_artists = set()
        a_songs = set()
        for h in a_hist + a_likes:
            s = h.get("song", {})
            if s.get("artist"):
                a_artists.add(str(s["artist"]).strip().lower())
            if s.get("videoId"):
                a_songs.add(str(s["videoId"]))
                
        b_artists = set()
        b_songs = set()
        for h in b_hist + b_likes:
            s = h.get("song", {})
            if s.get("artist"):
                b_artists.add(str(s["artist"]).strip().lower())
            if s.get("videoId"):
                b_songs.add(str(s["videoId"]))
                
        if not a_songs and not b_songs:
            return 50  # Neutral default for no data
            
        common_artists = a_artists.intersection(b_artists)
        common_songs_ids = a_songs.intersection(b_songs)
        
        min_artist_len = min(len(a_artists), len(b_artists))
        artist_similarity = len(common_artists) / max(1, min_artist_len) if min_artist_len > 0 else 0
        
        min_song_len = min(len(a_songs), len(b_songs))
        song_similarity = len(common_songs_ids) / max(1, min_song_len) if min_song_len > 0 else 0
        
        match_percentage = int(round(35 + 35 * artist_similarity + 28 * song_similarity))
        score = max(15, min(98, match_percentage))
        
        # Cache the result
        _cache_put(cache_key, score)
        return score
    except Exception:
        return 50

class ConnectionRequest(BaseModel):
    requesterId: str
    receiverId: str
    status: str  # pending, accepted, blocked
    tasteMatch: Optional[int] = 0

class RoomCreateRequest(BaseModel):
    name: str
    visibility: str = "public"  # public, circle

class RoomTrackUpdateRequest(BaseModel):
    song: SongSchema

class RoomPlaybackStateRequest(BaseModel):
    playing: bool
    timestamp: float

# Delegate room WebSocket management to the centralized realtime manager
ws_manager = realtime_manager

# Create Friend Request
@router.post("/request/{userId}")
async def send_friend_request(userId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    target_id = userId
    
    if my_id == target_id:
        raise HTTPException(status_code=400, detail="You cannot invite yourself into your Circle.")
        
    # Respect allowRequests privacy setting
    target_user = await database[db.USERS].find_one({"_id": parse_object_id(target_id)})
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found.")
        
    allow_req = target_user.get("settings", {}).get("allowRequests", True)
    if not allow_req:
        raise HTTPException(status_code=403, detail="This user has disabled incoming Circle requests.")
        
    # Check existing connection
    existing = await database[db.CONNECTIONS].find_one({
        "$or": [
            {"requesterId": my_id, "receiverId": target_id},
            {"requesterId": target_id, "receiverId": my_id}
        ]
    })
    
    if existing:
        if existing["status"] == "accepted":
            return {"success": True, "message": "Already in Circle."}
        elif existing["status"] == "pending":
            return {"success": True, "message": "Circle invitation is already pending."}
        elif existing["status"] == "blocked":
            raise HTTPException(status_code=403, detail="Connection is blocked.")

    match_score = await compute_taste_match_score(my_id, target_id)
    
    new_request = {
        "requesterId": my_id,
        "receiverId": target_id,
        "status": "pending",
        "tasteMatch": match_score,
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow()
    }
    
    await database[db.CONNECTIONS].insert_one(new_request)
    
    # Create notification
    notification = {
        "userId": target_id,
        "type": "friend_request",
        "senderId": my_id,
        "senderName": current_user.get("displayName", "Someone"),
        "senderAvatar": current_user.get("avatar"),
        "read": False,
        "createdAt": datetime.utcnow()
    }
    await database[db.NOTIFICATIONS].insert_one(notification)
    
    return {"success": True, "message": "Circle request dispatched."}

# Accept Request
@router.post("/accept/{requestId}")
async def accept_friend_request(requestId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    oid = parse_object_id(requestId)
    
    connection = await database[db.CONNECTIONS].find_one({"_id": oid})
    if not connection:
        raise HTTPException(status_code=404, detail="Request not found.")
        
    if connection["receiverId"] != my_id:
        raise HTTPException(status_code=403, detail="Unauthorized action on this request.")
        
    await database[db.CONNECTIONS].update_one(
        {"_id": oid},
        {"$set": {"status": "accepted", "updatedAt": datetime.utcnow()}}
    )
    
    # Create notification for requester
    notification = {
        "userId": connection["requesterId"],
        "type": "accepted",
        "senderId": my_id,
        "senderName": current_user.get("displayName", "Someone"),
        "senderAvatar": current_user.get("avatar"),
        "read": False,
        "createdAt": datetime.utcnow()
    }
    await database[db.NOTIFICATIONS].insert_one(notification)
    
    return {"success": True, "message": "Circle invitation accepted."}

# Remove Connection
@router.post("/remove/{userId}")
async def remove_connection(userId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    await database[db.CONNECTIONS].delete_many({
        "$or": [
            {"requesterId": my_id, "receiverId": userId},
            {"requesterId": userId, "receiverId": my_id}
        ]
    })
    
    return {"success": True, "message": "User removed from Circle."}

# Get Friend Requests
@router.get("/requests")
async def get_friend_requests(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    cursor = database[db.CONNECTIONS].find({
        "receiverId": my_id,
        "status": "pending"
    })
    
    # Collect all requester IDs for batch taste score computation
    request_docs = []
    requester_ids = []
    async for doc in cursor:
        doc["id"] = str(doc["_id"])
        del doc["_id"]
        requester_ids.append(doc["requesterId"])
        request_docs.append(doc)
    
    # Batch compute taste scores for all requesters
    taste_scores = await batch_compute_taste_scores(my_id, requester_ids)
    
    # Batch fetch all requester user details
    requester_ids_obj = [parse_object_id(rid) for rid in requester_ids if ObjectId.is_valid(rid)]
    senders = await database[db.USERS].find({"_id": {"$in": requester_ids_obj}}).to_list(length=100)
    senders_map = {str(s["_id"]): s for s in senders}
    
    requests_list = []
    for doc in request_docs:
        sender = senders_map.get(doc["requesterId"])
        if sender:
            doc["sender"] = {
                "id": str(sender["_id"]),
                "displayName": sender.get("displayName"),
                "username": sender.get("username"),
                "avatar": sender.get("avatar")
            }
            doc["tasteMatch"] = taste_scores.get(doc["requesterId"], 50)
        requests_list.append(doc)
        
    return {"success": True, "data": requests_list}

# Get Friend Circle
@router.get("/circle")
async def get_circle(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    cursor = database[db.CONNECTIONS].find({
        "$or": [{"requesterId": my_id}, {"receiverId": my_id}],
        "status": "accepted"
    })
    
    # Collect all friend IDs for batch operations
    connections = []
    friend_ids = []
    async for conn in cursor:
        friend_id = conn["receiverId"] if conn["requesterId"] == my_id else conn["requesterId"]
        connections.append(conn)
        friend_ids.append(friend_id)
    
    if not friend_ids:
        return {"success": True, "data": []}
    
    # Batch fetch all friend user details
    friend_ids_obj = [parse_object_id(fid) for fid in friend_ids if ObjectId.is_valid(fid)]
    friend_users = await database[db.USERS].find({"_id": {"$in": friend_ids_obj}}).to_list(length=200)
    users_map = {str(u["_id"]): u for u in friend_users}
    
    # Batch fetch activities for all friends who have showListeningActivity enabled
    activity_users = [fid for fid in friend_ids if users_map.get(fid, {}).get("settings", {}).get("showListeningActivity", True)]
    activities = []
    if activity_users:
        act_cursor = database[db.ACTIVITIES].find({
            "userId": {"$in": activity_users},
            "type": "listening"
        })
        activities = await act_cursor.to_list(length=200)
    activities_map = {a["userId"]: a for a in activities}
    
    # Batch compute taste scores for all friends
    taste_scores = await batch_compute_taste_scores(my_id, friend_ids)
    
    # Build response
    friends = []
    for conn in connections:
        friend_id = conn["receiverId"] if conn["requesterId"] == my_id else conn["requesterId"]
        f_user = users_map.get(friend_id)
        if not f_user:
            continue
            
        # Check online/presence status
        last_active = f_user.get("lastActive")
        is_online = False
        if last_active:
            # Online if active in the last 45 seconds
            is_online = (datetime.utcnow() - last_active).total_seconds() < 45

        # Check current listening activity (respect settings)
        show_act = f_user.get("settings", {}).get("showListeningActivity", True)
        current_activity = None
        if show_act:
            act = activities_map.get(friend_id)
            if act:
                current_activity = {
                    "song": act.get("song"),
                    "timestamp": act.get("timestamp").isoformat() if act.get("timestamp") else None
                }
                is_online = True
                
        # Get precomputed taste match score
        taste_match_score = taste_scores.get(friend_id, 50)
        
        friends.append({
            "id": friend_id,
            "displayName": f_user.get("displayName"),
            "username": f_user.get("username"),
            "avatar": f_user.get("avatar"),
            "tasteMatch": taste_match_score,
            "isOnline": is_online,
            "currentActivity": current_activity
        })
        
    return {"success": True, "data": friends}

# Rooms Endpoint: List Rooms
@router.get("/rooms")
async def list_rooms(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    cursor = database[db.ROOMS].find()
    
    rooms_list = []
    async for r in cursor:
        r["id"] = str(r["_id"])
        del r["_id"]
        # Fetch host name
        host = await database[db.USERS].find_one({"_id": parse_object_id(r["hostId"])})
        r["hostName"] = host.get("displayName", "Someone") if host else "Unknown"
        rooms_list.append(r)
        
    return {"success": True, "data": rooms_list}

# Create Room
@router.post("/rooms")
async def create_room(payload: RoomCreateRequest, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    new_room = {
        "name": sanitize_text(payload.name, max_length=100),
        "hostId": my_id,
        "members": [my_id],
        "currentTrack": None,
        "playbackState": {
            "playing": False,
            "timestamp": 0.0,
            "updatedAt": datetime.utcnow()
        },
        "queue": [],
        "visibility": payload.visibility if payload.visibility in {"public", "circle"} else "public",
        "createdAt": datetime.utcnow()
    }
    
    res = await database[db.ROOMS].insert_one(new_room)
    new_room["id"] = str(res.inserted_id)
    del new_room["_id"]
    return {"success": True, "data": new_room}

# Get Room Info
@router.get("/rooms/{roomId}")
async def get_room(roomId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    oid = parse_object_id(roomId)
    
    room = await database[db.ROOMS].find_one({"_id": oid})
    if not room:
        raise HTTPException(status_code=404, detail="Strumm Room not found.")
        
    room["id"] = str(room["_id"])
    del room["_id"]
    # Fetch member profile details
    members_profiles = []
    for mid in room.get("members", []):
        m_user = await database[db.USERS].find_one({"_id": parse_object_id(mid)})
        if m_user:
            members_profiles.append({
                "id": mid,
                "displayName": m_user.get("displayName"),
                "avatar": m_user.get("avatar")
            })
    room["membersProfiles"] = members_profiles
    
    return {"success": True, "data": room}

# Delete Room
@router.delete("/rooms/{roomId}")
async def delete_room(roomId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    oid = parse_object_id(roomId)
    
    room = await database[db.ROOMS].find_one({"_id": oid})
    if not room:
        raise HTTPException(status_code=404, detail="Strumm Room not found.")
        
    if room.get("hostId") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Only the room host can delete this room.")
        
    # Notify connected websocket clients via the centralized connection manager
    await ws_manager.broadcast_to_room(
        room_id=roomId,
        message={"type": "room_deleted"},
    )
    
    # Delete the room from the database
    await database[db.ROOMS].delete_one({"_id": oid})
            
    return {"success": True, "message": "Room deleted successfully."}

# Blend Playlist Generator
@router.post("/blend/{targetUserId}")
async def generate_blend(targetUserId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    target_user = await database[db.USERS].find_one({"_id": parse_object_id(targetUserId)})
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found.")
        
    # Support both string and ObjectId user queries to avoid data type mismatches
    possible_my_ids = [my_id]
    if ObjectId.is_valid(my_id):
        possible_my_ids.append(ObjectId(my_id))
        
    possible_target_ids = [targetUserId]
    if ObjectId.is_valid(targetUserId):
        possible_target_ids.append(ObjectId(targetUserId))

    # Collect songs from both users (Liked songs + Playback history)
    my_likes = await database[db.LIKED_SONGS].find({"userId": {"$in": possible_my_ids}}).to_list(length=200)
    target_likes = await database[db.LIKED_SONGS].find({"userId": {"$in": possible_target_ids}}).to_list(length=200)
    
    my_history = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_my_ids}}).to_list(length=200)
    target_history = await database[db.PLAYBACK_HISTORIES].find({"userId": {"$in": possible_target_ids}}).to_list(length=200)
    
    # Map song data by videoId for both users to find overlapping songs
    my_songs_map = {}
    for doc in my_likes + my_history:
        song = doc.get("song", {})
        vid = song.get("videoId")
        if vid:
            my_songs_map[vid] = song

    target_songs_map = {}
    for doc in target_likes + target_history:
        song = doc.get("song", {})
        vid = song.get("videoId")
        if vid:
            target_songs_map[vid] = song

    my_vids = set(my_songs_map.keys())
    target_vids = set(target_songs_map.keys())
    overlapping_vids = my_vids.intersection(target_vids)
    
    # If 0 overlapping songs, block blend creation and inform the user
    if not overlapping_vids:
        raise HTTPException(
            status_code=400,
            detail="Not enough music compatibility between you to generate a Blend playlist. Listen to more overlapping tracks first!"
        )
        
    # Create the Blend playlist using overlapping songs first, and then build up to 50 songs
    blend_songs = []
    for vid in overlapping_vids:
        blend_songs.append(my_songs_map[vid])
        
    # Alternating unique songs from both users
    my_unique = [my_songs_map[vid] for vid in my_vids if vid not in overlapping_vids]
    target_unique = [target_songs_map[vid] for vid in target_vids if vid not in overlapping_vids]
    
    max_len = 50
    i = 0
    while len(blend_songs) < max_len and (i < len(my_unique) or i < len(target_unique)):
        if i < len(my_unique) and len(blend_songs) < max_len:
            blend_songs.append(my_unique[i])
        if i < len(target_unique) and len(blend_songs) < max_len:
            blend_songs.append(target_unique[i])
        i += 1
    
    name = f"{current_user.get('displayName', 'User')} × {target_user.get('displayName', 'User')} Mix"
    
    # Insert new special blend playlist
    blend_playlist = {
        "userId": my_id,
        "name": name,
        "description": f"Custom Strumm Blend. Combined soundscapes of {current_user.get('displayName')} and {target_user.get('displayName')}.",
        "songs": blend_songs,
        "visibility": "public",
        "followers": 0,
        "isBlend": True,
        "blendUsers": [my_id, targetUserId],
        "createdAt": datetime.utcnow()
    }
    
    res = await database[db.PLAYLISTS].insert_one(blend_playlist)
    blend_playlist["id"] = str(res.inserted_id)
    del blend_playlist["_id"]
    
    # Create notification for target user
    notification = {
        "userId": targetUserId,
        "type": "memory_shared", # custom notify type for blend mix
        "senderId": my_id,
        "senderName": current_user.get("displayName", "Someone"),
        "senderAvatar": current_user.get("avatar"),
        "message": f"created a Blend playlist '{name}' with you.",
        "read": False,
        "createdAt": datetime.utcnow()
    }
    await database[db.NOTIFICATIONS].insert_one(notification)
    
    return {"success": True, "data": blend_playlist}

# Simple reactions on song memories
@router.post("/memories/{memoryId}/react")
async def react_to_memory(
    memoryId: str, 
    reactionType: str = Body(..., embed=True), 
    current_user: dict = Depends(get_current_user)
):
    database = db.get_db()
    my_id = current_user["id"]
    oid = parse_object_id(memoryId)
    
    memory = await database["songMemories"].find_one({"_id": oid})
    if not memory:
        raise HTTPException(status_code=404, detail="Memory not found.")
        
    # Check visibility rules (e.g. circle only if is accepted friend)
    creator_id = memory["userId"]
    if memory.get("visibility") == "circle" and creator_id != my_id:
        conn = await database[db.CONNECTIONS].find_one({
            "$or": [
                {"requesterId": my_id, "receiverId": creator_id},
                {"requesterId": creator_id, "receiverId": my_id}
            ],
            "status": "accepted"
        })
        if not conn:
            raise HTTPException(status_code=403, detail="This shared memory is locked to Circle members.")
            
    if memory.get("visibility") == "private" and creator_id != my_id:
        raise HTTPException(status_code=403, detail="Memory is private.")

    # Update simple reactions
    field_path = f"reactions.{reactionType}"
    await database["songMemories"].update_one(
        {"_id": oid},
        {"$addToSet": {field_path: my_id}},
        upsert=True
    )
    
    return {"success": True, "message": "Reaction updated."}

# Get Notifications
@router.get("/notifications")
async def get_notifications(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    user_id_str = current_user["id"]
    user_id_oid = parse_object_id(user_id_str)
    cursor = database[db.NOTIFICATIONS].find({
        "userId": {"$in": [user_id_str, user_id_oid]}
    }).sort("createdAt", -1).limit(40)
    
    notifs = []
    async for n in cursor:
        n["id"] = str(n["_id"])
        del n["_id"]
        if "createdAt" in n:
            n["createdAt"] = n["createdAt"].isoformat()
        notifs.append(n)
        
    return {"success": True, "data": notifs}

# Clear notifications
@router.post("/notifications/clear")
async def clear_notifications(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    user_id_str = current_user["id"]
    user_id_oid = parse_object_id(user_id_str)
    await database[db.NOTIFICATIONS].update_many(
        {"userId": {"$in": [user_id_str, user_id_oid]}, "read": False},
        {"$set": {"read": True}}
    )
    return {"success": True}

# Permanently delete all notifications
@router.delete("/notifications")
async def delete_all_notifications(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    user_id_str = current_user["id"]
    user_id_oid = parse_object_id(user_id_str)
    await database[db.NOTIFICATIONS].delete_many(
        {"userId": {"$in": [user_id_str, user_id_oid]}}
    )
    return {"success": True, "message": "All notifications permanently deleted."}


@router.get("/status/{userId}")
async def get_connection_status(userId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    conn = await database[db.CONNECTIONS].find_one({
        "$or": [
            {"requesterId": my_id, "receiverId": userId},
            {"requesterId": userId, "receiverId": my_id}
        ]
    })
    
    if not conn:
        return {"success": True, "status": "none"}
        
    return {
        "success": True,
        "status": conn["status"], # pending, accepted, blocked
        "isRequester": conn["requesterId"] == my_id,
        "requestId": str(conn["_id"])
    }

class DirectMessageRequest(BaseModel):
    receiverId: str
    message: Optional[str] = None
    song: Optional[dict] = None

@router.post("/message")
async def send_direct_message(
    payload: DirectMessageRequest,
    current_user: dict = Depends(get_current_user)
):
    database = db.get_db()
    my_id = current_user["id"]
    receiver_id = payload.receiverId
    
    my_id_oid = parse_object_id(my_id)
    receiver_id_oid = parse_object_id(receiver_id)
    # Verify that they are circle members (friends)
    conn = await database[db.CONNECTIONS].find_one({
        "$or": [
            {"requesterId": {"$in": [my_id, my_id_oid]}, "receiverId": {"$in": [receiver_id, receiver_id_oid]}},
            {"requesterId": {"$in": [receiver_id, receiver_id_oid]}, "receiverId": {"$in": [my_id, my_id_oid]}}
        ],
        "status": "accepted"
    })
    if not conn:
        raise HTTPException(status_code=403, detail="You can only send messages/songs to your Circle members.")
        
    notification_type = "chat_message"
    message_text = sanitize_text(payload.message, max_length=500) if payload.message else "sent you a wave."
    
    song_data = None
    if payload.song:
        notification_type = "song_shared"
        song_data = {
            "videoId": sanitize_text(payload.song.get("videoId"), max_length=100),
            "title": sanitize_text(payload.song.get("title"), max_length=200),
            "artist": sanitize_text(payload.song.get("artist"), max_length=200),
            "thumbnail": sanitize_text(payload.song.get("thumbnail"), max_length=1000)
        }
        if payload.message:
            message_text = f"\"{sanitize_text(payload.message, max_length=300)}\" (shared track: '{song_data['title']}')"
        else:
            message_text = f"shared a song: '{song_data['title']}' by {song_data['artist']}"
            
    notification = {
        "userId": receiver_id,
        "type": notification_type,
        "senderId": my_id,
        "senderName": current_user.get("displayName", "Someone"),
        "senderAvatar": current_user.get("avatar"),
        "message": message_text,
        "song": song_data,
        "read": False,
        "createdAt": datetime.utcnow()
    }
    await database[db.NOTIFICATIONS].insert_one(notification)
    return {"success": True, "message": "Song/Message sent successfully."}

# Room WebSocket Signaling and Sync Endpoint
@router.websocket("/rooms/{roomId}/ws")
async def room_websocket_endpoint(websocket: WebSocket, roomId: str):
    # Authenticate via JWT access token from Sec-WebSocket-Protocol header
    # Using the subprotocol header instead of query parameter to prevent
    # token leakage in server access logs and Referer headers.
    token = None
    # Read token from the first subprotocol offered by the client
    protocols = websocket.headers.get("sec-websocket-protocol", "")
    if protocols:
        # The client sends "authorization, <token>" as subprotocol
        for p in protocols.split(","):
            p = p.strip()
            if p and p != "authorization":
                token = p
                break
    
    if not token:
        # Fallback: check query parameter (backward compatibility)
        from starlette.datastructures import QueryParams
        query_string = websocket.url.query
        if query_string:
            params = QueryParams(query_string)
            token = params.get("token")
    
    if not token:
        logger.warning("Room WS rejected — no token provided (roomId=%s)", roomId)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Authentication required")
        return
        
    payload = decode_access_token(token)
    payload = decode_access_token(token)
    if not payload:
        logger.warning("Room WS rejected — invalid token (roomId=%s)", roomId)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid or expired token")
        return
    if payload.get("type") != "access":
        logger.warning("Room WS rejected — refresh token used (roomId=%s)", roomId)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Refresh tokens cannot be used for WebSocket connections")
        return
    userId = payload.get("sub")
    if not userId:
        logger.warning("Room WS rejected — missing sub claim (roomId=%s)", roomId)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid token payload")
        return

    await ws_manager.connect_room(roomId, userId, websocket)
    database = db.get_db()
    
    # Update room member lists
    await database[db.ROOMS].update_one(
        {"_id": parse_object_id(roomId)},
        {"$addToSet": {"members": userId}}
    )
    
    # Broadcast join
    await ws_manager.broadcast_to_room(
        room_id=roomId, 
        message={"event": "room:join", "data": {"userId": userId}},
        exclude_user_id=userId
    )
    
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            event = payload.get("event")
            event_data = payload.get("data", {})
            
            if event == "track:update":
                # Update tracks
                await database[db.ROOMS].update_one(
                    {"_id": parse_object_id(roomId)},
                    {"$set": {"currentTrack": event_data.get("song")}}
                )
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": "track:update", "data": event_data},
                    exclude_user_id=userId
                )
                
            elif event in {"play", "pause", "seek"}:
                # Update playbackState
                playback_state = {
                    "playing": event == "play",
                    "timestamp": event_data.get("timestamp", 0.0),
                    "updatedAt": datetime.utcnow()
                }
                await database[db.ROOMS].update_one(
                    {"_id": parse_object_id(roomId)},
                    {"$set": {"playbackState": playback_state}}
                )
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": event, "data": event_data},
                    exclude_user_id=userId
                )
                
            elif event == "queue:add":
                # Push songs into room queue
                await database[db.ROOMS].update_one(
                    {"_id": parse_object_id(roomId)},
                    {"$push": {"queue": event_data.get("song")}}
                )
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": "queue:add", "data": event_data}
                )
                
            elif event == "signal":
                # WebRTC Signaling voice channel bypass
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": "signal", "data": event_data},
                    exclude_user_id=userId
                )
                
            elif event == "chat:message":
                # Broadcast chat messages to other room members
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": "chat:message", "data": event_data},
                    exclude_user_id=userId
                )
                
    except WebSocketDisconnect:
        ws_manager.disconnect_room(roomId, websocket)
        # Pull member lists
        await database[db.ROOMS].update_one(
            {"_id": parse_object_id(roomId)},
            {"$pull": {"members": userId}}
        )


# Combined Circle Data Endpoint - Get all circle data in one call
@router.get("/circle/all")
async def get_all_circle_data(current_user: dict = Depends(get_current_user)):
    """
    Get friends, requests, and notifications in a single optimized call.
    Uses batch operations for significantly better performance.
    """
    database = db.get_db()
    my_id = current_user["id"]
    
    # 1. Fetch all accepted connections (friends)
    conn_cursor = database[db.CONNECTIONS].find({
        "$or": [{"requesterId": my_id}, {"receiverId": my_id}],
        "status": "accepted"
    })
    
    connections = []
    friend_ids = []
    async for conn in conn_cursor:
        friend_id = conn["receiverId"] if conn["requesterId"] == my_id else conn["requesterId"]
        connections.append(conn)
        friend_ids.append(friend_id)
    
    # 2. Fetch all pending requests (received)
    req_cursor = database[db.CONNECTIONS].find({
        "receiverId": my_id,
        "status": "pending"
    })
    
    requests = []
    requester_ids = []
    async for doc in req_cursor:
        doc["id"] = str(doc["_id"])
        del doc["_id"]
        requests.append(doc)
        requester_ids.append(doc["requesterId"])
    
    # 3. Fetch notifications
    user_id_str = my_id
    user_id_oid = parse_object_id(user_id_str)
    notif_cursor = database[db.NOTIFICATIONS].find({
        "userId": {"$in": [user_id_str, user_id_oid]}
    }).sort("createdAt", -1).limit(40)
    
    notifications = []
    async for n in notif_cursor:
        n["id"] = str(n["_id"])
        del n["_id"]
        if "createdAt" in n:
            n["createdAt"] = n["createdAt"].isoformat()
        notifications.append(n)
    
    # If no friends and no requests, return early
    if not friend_ids and not requester_ids:
        return {
            "success": True,
            "data": {
                "friends": [],
                "requests": [],
                "notifications": notifications
            }
        }
    
    # 4. Batch fetch all user details needed
    all_user_ids = list(set(friend_ids + requester_ids))
    all_user_ids_obj = [parse_object_id(uid) for uid in all_user_ids if ObjectId.is_valid(uid)]
    users = await database[db.USERS].find({"_id": {"$in": all_user_ids_obj}}).to_list(length=300)
    users_map = {str(u["_id"]): u for u in users}
    
    # 5. Batch fetch activities for friends
    activity_users = [fid for fid in friend_ids if users_map.get(fid, {}).get("settings", {}).get("showListeningActivity", True)]
    activities_map = {}
    if activity_users:
        act_cursor = database[db.ACTIVITIES].find({
            "userId": {"$in": activity_users},
            "type": "listening"
        })
        activities = await act_cursor.to_list(length=200)
        activities_map = {a["userId"]: a for a in activities}
    
    # 6. Batch compute taste scores for all users
    all_taste_ids = list(set(friend_ids + requester_ids))
    taste_scores = await batch_compute_taste_scores(my_id, all_taste_ids)
    
    # 7. Build friends response
    friends = []
    for conn in connections:
        friend_id = conn["receiverId"] if conn["requesterId"] == my_id else conn["requesterId"]
        f_user = users_map.get(friend_id)
        if not f_user:
            continue
            
        last_active = f_user.get("lastActive")
        is_online = False
        if last_active:
            is_online = (datetime.utcnow() - last_active).total_seconds() < 45

        show_act = f_user.get("settings", {}).get("showListeningActivity", True)
        current_activity = None
        if show_act:
            act = activities_map.get(friend_id)
            if act:
                current_activity = {
                    "song": act.get("song"),
                    "timestamp": act.get("timestamp").isoformat() if act.get("timestamp") else None
                }
                is_online = True
                
        friends.append({
            "id": friend_id,
            "displayName": f_user.get("displayName"),
            "username": f_user.get("username"),
            "avatar": f_user.get("avatar"),
            "tasteMatch": taste_scores.get(friend_id, 50),
            "isOnline": is_online,
            "currentActivity": current_activity
        })
    
    # 8. Build requests response
    requests_list = []
    for doc in requests:
        sender = users_map.get(doc["requesterId"])
        if sender:
            doc["sender"] = {
                "id": str(sender["_id"]),
                "displayName": sender.get("displayName"),
                "username": sender.get("username"),
                "avatar": sender.get("avatar")
            }
            doc["tasteMatch"] = taste_scores.get(doc["requesterId"], 50)
        requests_list.append(doc)
    
    return {
        "success": True,
        "data": {
            "friends": friends,
            "requests": requests_list,
            "notifications": notifications
        }
    }
