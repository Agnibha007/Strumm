from fastapi import APIRouter, Depends, HTTPException, status, WebSocket, WebSocketDisconnect, Body
from typing import List, Optional, Dict, Any
from datetime import datetime, timedelta
from bson import ObjectId
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import SongSchema
from app.services.security import parse_object_id, sanitize_text
from pydantic import BaseModel
import logging
import json

logger = logging.getLogger("strumm-social")
router = APIRouter(prefix="/social", tags=["social"])

CONNECTIONS_COLLECTION = "connections"
ACTIVITIES_COLLECTION = "activities"
ROOMS_COLLECTION = "rooms"
NOTIFICATIONS_COLLECTION = "notifications"

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

# Connection Manager for WebSockets Room Synced playback
class ConnectionManager:
    def __init__(self):
        # room_id -> list of tuple (userId, WebSocket)
        self.active_connections: Dict[str, List[tuple[str, WebSocket]]] = {}

    async def connect(self, room_id: str, user_id: str, websocket: WebSocket):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append((user_id, websocket))

    def disconnect(self, room_id: str, websocket: WebSocket):
        if room_id in self.active_connections:
            self.active_connections[room_id] = [c for c in self.active_connections[room_id] if c[1] != websocket]
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]

    async def send_to_user(self, websocket: WebSocket, message: dict):
        try:
            await websocket.send_json(message)
        except Exception:
            pass

    async def broadcast_to_room(self, room_id: str, message: dict, exclude_user_id: Optional[str] = None):
        if room_id in self.active_connections:
            for user_id, websocket in self.active_connections[room_id]:
                if exclude_user_id is None or user_id != exclude_user_id:
                    try:
                        await websocket.send_json(message)
                    except Exception:
                        pass

ws_manager = ConnectionManager()

# Helper: calculate taste match score dynamically
async def compute_taste_match_score(user_a_id: str, user_b_id: str) -> int:
    try:
        database = db.get_db()
        a_hist = await database[db.PLAYBACK_HISTORIES].find({"userId": user_a_id}).to_list(length=500)
        b_hist = await database[db.PLAYBACK_HISTORIES].find({"userId": user_b_id}).to_list(length=500)
        if not a_hist or not b_hist:
            return 50  # baseline
        a_artists = {str(h.get("song", {}).get("artist", "")).strip().lower() for h in a_hist if h.get("song", {}).get("artist")}
        b_artists = {str(h.get("song", {}).get("artist", "")).strip().lower() for h in b_hist if h.get("song", {}).get("artist")}
        common = a_artists.intersection(b_artists)
        union = a_artists.union(b_artists)
        if not union:
            return 50
        return int(round((len(common) / len(union)) * 100))
    except Exception:
        return 50

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
    existing = await database[CONNECTIONS_COLLECTION].find_one({
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
    
    await database[CONNECTIONS_COLLECTION].insert_one(new_request)
    
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
    await database[NOTIFICATIONS_COLLECTION].insert_one(notification)
    
    return {"success": True, "message": "Circle request dispatched."}

# Accept Request
@router.post("/accept/{requestId}")
async def accept_friend_request(requestId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    oid = parse_object_id(requestId)
    
    connection = await database[CONNECTIONS_COLLECTION].find_one({"_id": oid})
    if not connection:
        raise HTTPException(status_code=404, detail="Request not found.")
        
    if connection["receiverId"] != my_id:
        raise HTTPException(status_code=403, detail="Unauthorized action on this request.")
        
    await database[CONNECTIONS_COLLECTION].update_one(
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
    await database[NOTIFICATIONS_COLLECTION].insert_one(notification)
    
    return {"success": True, "message": "Circle invitation accepted."}

# Remove Connection
@router.post("/remove/{userId}")
async def remove_connection(userId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    await database[CONNECTIONS_COLLECTION].delete_many({
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
    
    cursor = database[CONNECTIONS_COLLECTION].find({
        "receiverId": my_id,
        "status": "pending"
    })
    
    requests_list = []
    async for doc in cursor:
        doc["id"] = str(doc["_id"])
        del doc["_id"]
        # Fetch requester user details
        sender = await database[db.USERS].find_one({"_id": parse_object_id(doc["requesterId"])})
        if sender:
            doc["sender"] = {
                "id": str(sender["_id"]),
                "displayName": sender.get("displayName"),
                "username": sender.get("username"),
                "avatar": sender.get("avatar")
            }
        requests_list.append(doc)
        
    return {"success": True, "data": requests_list}

# Get Friend Circle
@router.get("/circle")
async def get_circle(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    cursor = database[CONNECTIONS_COLLECTION].find({
        "$or": [{"requesterId": my_id}, {"receiverId": my_id}],
        "status": "accepted"
    })
    
    friends = []
    async for conn in cursor:
        friend_id = conn["receiverId"] if conn["requesterId"] == my_id else conn["requesterId"]
        f_user = await database[db.USERS].find_one({"_id": parse_object_id(friend_id)})
        if f_user:
            # Check current listening activity (respect settings)
            show_act = f_user.get("settings", {}).get("showListeningActivity", True)
            current_activity = None
            if show_act:
                act = await database[ACTIVITIES_COLLECTION].find_one({
                    "userId": friend_id,
                    "type": "listening"
                })
                if act:
                    current_activity = {
                        "song": act.get("song"),
                        "timestamp": act.get("timestamp").isoformat() if act.get("timestamp") else None
                    }
                    
            friends.append({
                "id": friend_id,
                "displayName": f_user.get("displayName"),
                "username": f_user.get("username"),
                "avatar": f_user.get("avatar"),
                "tasteMatch": conn.get("tasteMatch", 50),
                "currentActivity": current_activity
            })
            
    return {"success": True, "data": friends}

# Rooms Endpoint: List Rooms
@router.get("/rooms")
async def list_rooms(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    cursor = database[ROOMS_COLLECTION].find()
    
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
    
    res = await database[ROOMS_COLLECTION].insert_one(new_room)
    new_room["id"] = str(res.inserted_id)
    del new_room["_id"]
    return {"success": True, "data": new_room}

# Get Room Info
@router.get("/rooms/{roomId}")
async def get_room(roomId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    oid = parse_object_id(roomId)
    
    room = await database[ROOMS_COLLECTION].find_one({"_id": oid})
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

# Blend Playlist Generator
@router.post("/blend/{targetUserId}")
async def generate_blend(targetUserId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    target_user = await database[db.USERS].find_one({"_id": parse_object_id(targetUserId)})
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found.")
        
    # Collect songs from both users (Liked songs + Playback history)
    my_likes = await database[db.LIKED_SONGS].find({"userId": my_id}).to_list(length=100)
    target_likes = await database[db.LIKED_SONGS].find({"userId": targetUserId}).to_list(length=100)
    
    my_history = await database[db.PLAYBACK_HISTORIES].find({"userId": my_id}).to_list(length=100)
    target_history = await database[db.PLAYBACK_HISTORIES].find({"userId": targetUserId}).to_list(length=100)
    
    # Extract unique song structures
    song_pool = {}
    
    # Add target likes and history
    for doc in my_likes + target_likes:
        song = doc.get("song", {})
        vid = song.get("videoId")
        if vid and vid not in song_pool:
            song_pool[vid] = song
            
    for doc in my_history + target_history:
        song = doc.get("song", {})
        vid = song.get("videoId")
        if vid and vid not in song_pool:
            song_pool[vid] = song

    songs_list = list(song_pool.values())
    
    # Fallback to general songs if pool is empty
    if len(songs_list) < 5:
        cursor = database[db.SONGS].find().limit(50)
        async for song_doc in cursor:
            vid = song_doc.get("videoId")
            if vid and vid not in song_pool:
                songs_list.append({
                    "videoId": vid,
                    "title": song_doc.get("title", "Track"),
                    "artist": song_doc.get("artist", "Artist"),
                    "thumbnail": song_doc.get("thumbnail", ""),
                    "duration": song_doc.get("duration", 180)
                })

    # Pick 50 songs (or cap at available length)
    blend_songs = songs_list[:50]
    
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
    await database[NOTIFICATIONS_COLLECTION].insert_one(notification)
    
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
        conn = await database[CONNECTIONS_COLLECTION].find_one({
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
    cursor = database[NOTIFICATIONS_COLLECTION].find({
        "userId": current_user["id"]
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
    await database[NOTIFICATIONS_COLLECTION].update_many(
        {"userId": current_user["id"], "read": False},
        {"$set": {"read": True}}
    )
    return {"success": True}

@router.get("/status/{userId}")
async def get_connection_status(userId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]
    
    conn = await database[CONNECTIONS_COLLECTION].find_one({
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

# Room WebSocket Signaling and Sync Endpoint
@router.websocket("/rooms/{roomId}/ws")
async def room_websocket_endpoint(websocket: WebSocket, roomId: str, userId: str):
    await ws_manager.connect(roomId, userId, websocket)
    database = db.get_db()
    
    # Update room member lists
    await database[ROOMS_COLLECTION].update_one(
        {"_id": parse_object_id(roomId)},
        {"$addToSet": {"members": userId}}
    )
    
    # Broadcast join
    await ws_manager.broadcast_to_room(
        roomId, 
        {"event": "room:join", "data": {"userId": userId}},
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
                await database[ROOMS_COLLECTION].update_one(
                    {"_id": parse_object_id(roomId)},
                    {"$set": {"currentTrack": event_data.get("song")}}
                )
                await ws_manager.broadcast_to_room(roomId, {"event": "track:update", "data": event_data}, exclude_user_id=userId)
                
            elif event in {"play", "pause", "seek"}:
                # Update playbackState
                playback_state = {
                    "playing": event == "play",
                    "timestamp": event_data.get("timestamp", 0.0),
                    "updatedAt": datetime.utcnow()
                }
                await database[ROOMS_COLLECTION].update_one(
                    {"_id": parse_object_id(roomId)},
                    {"$set": {"playbackState": playback_state}}
                )
                await ws_manager.broadcast_to_room(roomId, {"event": event, "data": event_data}, exclude_user_id=userId)
                
            elif event == "queue:add":
                # Push songs into room queue
                await database[ROOMS_COLLECTION].update_one(
                    {"_id": parse_object_id(roomId)},
                    {"$push": {"queue": event_data.get("song")}}
                )
                await ws_manager.broadcast_to_room(roomId, {"event": "queue:add", "data": event_data}, exclude_user_id=userId)
                
            elif event == "signal":
                # WebRTC Signaling voice channel bypass
                await ws_manager.broadcast_to_room(roomId, {"event": "signal", "data": event_data}, exclude_user_id=userId)
                
    except WebSocketDisconnect:
        ws_manager.disconnect(roomId, websocket)
        # Pull member lists
        await database[ROOMS_COLLECTION].update_one(
            {"_id": parse_object_id(roomId)},
            {"$pull": {"members": userId}}
        )
        await ws_manager.broadcast_to_room(
            roomId, 
            {"event": "room:leave", "data": {"userId": userId}}
        )
