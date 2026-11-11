"""Listening Rooms API.

Room state and presence are persisted in MongoDB. The browser uses short REST
polls and heartbeat leases, so state is consistent across API replicas.
"""

from datetime import datetime, timedelta
import html
import math
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from fastapi.encoders import jsonable_encoder

from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.security import sanitize_text
from app.services.realtime.connection_manager import manager
from app.services.rooms import (
    PRESENCE_COLLECTION,
    PRESENCE_TTL_SECONDS,
    clean_song,
    get_room,
    new_join_code,
    require_member,
    serialize_room,
)

router = APIRouter(prefix="/social/rooms", tags=["rooms"])


class CreateRoomBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class JoinRoomBody(BaseModel):
    code: str | None = Field(default=None, min_length=6, max_length=6)


class PlaybackBody(BaseModel):
    song: dict | None = None
    playing: bool
    timestamp: float = Field(default=0, ge=0, le=86400)
    deviceId: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    direct: bool = False
    sequence: int | None = Field(default=None, ge=1)


class QueueBody(BaseModel):
    song: dict


class LeaveRoomBody(BaseModel):
    delete_room: bool = False


class PlaybackReadyBody(BaseModel):
    sequence: int = Field(ge=1)
    deviceId: str = Field(pattern=r"^[0-9a-f]{32}$")


async def _room_or_404(room_id: str) -> dict:
    room = await get_room(db.get_db(), room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found.")
    return room


async def _broadcast_room_state(database, room: dict) -> None:
    room_id = str(room["_id"])
    snapshot = jsonable_encoder(await serialize_room(database, room))
    await manager.broadcast_to_room(
        room_id,
        {"event": "room:state", "data": {"roomId": room_id, "room": snapshot}},
    )


async def _unique_code(database) -> str:
    for _ in range(10):
        code = new_join_code()
        if not await database[db.ROOMS].find_one({"joinCode": code}, {"_id": 1}):
            return code
    raise HTTPException(status_code=503, detail="Could not generate a room code. Try again.")


@router.get("")
async def list_rooms(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    user_id = current_user["id"]
    cursor = database[db.ROOMS].find({
        "$or": [{"hostId": user_id}, {"members": user_id}]
    }).sort("createdAt", -1).limit(50)
    rooms = [await serialize_room(database, room, user_id) async for room in cursor]
    return {"success": True, "data": rooms}


@router.post("")
async def create_room(payload: CreateRoomBody, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    name = html.unescape(sanitize_text(payload.name, max_length=60)).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give your room a name.")
    room = {
        "name": name,
        "hostId": current_user["id"],
        "hostName": current_user.get("displayName") or current_user.get("username") or "Host",
        "members": [current_user["id"]],
        "joinCode": await _unique_code(database),
        "currentTrack": None,
        "playbackState": {"playing": False, "timestamp": 0, "updatedAt": datetime.utcnow(), "startAt": None, "sequence": 0},
        "queue": [],
        "createdAt": datetime.utcnow(),
    }
    result = await database[db.ROOMS].insert_one(room)
    room["_id"] = result.inserted_id
    return {"success": True, "data": await serialize_room(database, room, current_user["id"])}


@router.get("/by-code/{code}")
async def resolve_code(code: str, current_user: dict = Depends(get_current_user)):
    cleaned = "".join(code.upper().split())
    room = await db.get_db()[db.ROOMS].find_one({"joinCode": cleaned})
    if not room:
        raise HTTPException(status_code=404, detail="No room found for that code.")
    return {"success": True, "data": {
        "id": str(room["_id"]), "name": room.get("name"),
        "hostName": room.get("hostName", "Host"),
    }}


@router.post("/{room_id}/join")
async def join_room(
    room_id: str,
    payload: JoinRoomBody | None = None,
    current_user: dict = Depends(get_current_user),
):
    database = db.get_db()
    room = await _room_or_404(room_id)
    user_id = current_user["id"]
    already_member = user_id in (room.get("members") or []) or room.get("hostId") == user_id
    supplied_code = (payload.code or "").upper() if payload else ""
    stored_code = room.get("joinCode") or ""
    if not already_member and (
        not supplied_code or not secrets.compare_digest(supplied_code, stored_code)
    ):
        raise HTTPException(status_code=403, detail="A valid room code is required to join.")
    await database[db.ROOMS].update_one(
        {"_id": room["_id"]}, {"$addToSet": {"members": user_id}}
    )
    room = await get_room(database, room_id)
    return {"success": True, "data": await serialize_room(database, room, current_user["id"])}


@router.get("/{room_id}")
async def room_snapshot(room_id: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    room = await _room_or_404(room_id)
    await require_member(database, room, current_user["id"])
    return {"success": True, "data": await serialize_room(database, room, current_user["id"])}


@router.post("/{room_id}/heartbeat")
async def room_heartbeat(room_id: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    room = await _room_or_404(room_id)
    user_id = current_user["id"]
    await require_member(database, room, user_id)
    now = datetime.utcnow()
    await database[PRESENCE_COLLECTION].update_one(
        {"roomId": room_id, "userId": user_id},
        {"$set": {
            "roomId": room_id, "userId": user_id,
            "lastSeenAt": now,
            "expiresAt": now + timedelta(seconds=PRESENCE_TTL_SECONDS * 3),
        }},
        upsert=True,
    )
    return {"success": True, "data": await serialize_room(database, room, current_user["id"])}


@router.post("/{room_id}/playback")
async def update_playback(
    room_id: str,
    payload: PlaybackBody,
    current_user: dict = Depends(get_current_user),
):
    database = db.get_db()
    room = await _room_or_404(room_id)
    user_id = current_user["id"]
    await require_member(database, room, user_id)
    if room.get("hostId") != user_id:
        raise HTTPException(status_code=403, detail="Only the host can control playback.")
    song = clean_song(payload.song) if payload.song is not None else None
    if payload.song is not None and song is None:
        raise HTTPException(status_code=400, detail="Invalid song.")
    timestamp = payload.timestamp if math.isfinite(payload.timestamp) else 0
    previous_state = room.get("playbackState") or {}
    now = datetime.utcnow()
    if payload.direct:
        previous_sequence = int(previous_state.get("sequence") or 0)
        if payload.sequence is not None and payload.sequence <= previous_sequence:
            return {"success": True, "data": await serialize_room(database, room, user_id)}
        sequence = max(previous_sequence + 1, payload.sequence or 0)
        state = {
            "playing": payload.playing,
            "targetPlaying": payload.playing,
            "timestamp": timestamp,
            "updatedAt": now,
            "startAt": int(time.time() * 1000),
            "sequence": sequence,
            "phase": "committed",
        }
        update = {"$set": {"currentTrack": song or room.get("currentTrack"), "playbackState": state}}
        if song:
            update["$pull"] = {"queue": {"videoId": song["videoId"]}}
        await database[db.ROOMS].update_one({"_id": room["_id"]}, update)
        updated = await get_room(database, room_id)
        return {"success": True, "data": await serialize_room(database, updated, user_id)}
    # Two-phase barrier: clients prepare the media surface and report ready.
    # The server commits only after every currently connected room participant
    # has prepared, then publishes one shared execution deadline.
    sequence = int(previous_state.get("sequence") or 0) + 1
    connected_clients = manager.room_connected_clients(room_id)
    participant_users = {client["deviceId"]: client["userId"] for client in connected_clients}
    participants = sorted(participant_users)
    if payload.deviceId:
        participant_users[payload.deviceId] = user_id
        participants = sorted(set(participants) | {payload.deviceId})
    state = {
        "playing": previous_state.get("playing", False),
        "targetPlaying": payload.playing,
        "timestamp": timestamp,
        "updatedAt": now,
        "startAt": None,
        "sequence": sequence,
        "phase": "preparing",
        "commandAt": int(time.time() * 1000),
        "participants": participants,
        "participantUsers": participant_users,
        "readyDeviceIds": [],
    }
    update = {"$set": {"currentTrack": song, "playbackState": state}}
    if song:
        update["$pull"] = {"queue": {"videoId": song["videoId"]}}
    await database[db.ROOMS].update_one({"_id": room["_id"]}, update)
    updated = await get_room(database, room_id)
    await _broadcast_room_state(database, updated)
    return {"success": True, "data": await serialize_room(database, updated, current_user["id"])}


@router.post("/{room_id}/playback/ready")
async def playback_ready(
    room_id: str,
    payload: PlaybackReadyBody,
    current_user: dict = Depends(get_current_user),
):
    database = db.get_db()
    room = await _room_or_404(room_id)
    user_id = current_user["id"]
    await require_member(database, room, user_id)
    state = room.get("playbackState") or {}
    if state.get("phase") != "preparing" or state.get("sequence") != payload.sequence:
        return {"success": True, "data": await serialize_room(database, room, user_id)}

    participants = set(state.get("participants") or [])
    participant_users = state.get("participantUsers") or {}
    if participant_users.get(payload.deviceId) != user_id:
        raise HTTPException(status_code=403, detail="This device is not part of the active sync.")
    if payload.deviceId not in participants:
        return {"success": True, "data": await serialize_room(database, room, user_id)}
    await database[db.ROOMS].update_one(
        {
            "_id": room["_id"],
            "playbackState.sequence": payload.sequence,
            "playbackState.phase": "preparing",
        },
        {"$addToSet": {"playbackState.readyDeviceIds": payload.deviceId}},
    )
    updated = await get_room(database, room_id)
    ready_ids = set((updated.get("playbackState") or {}).get("readyDeviceIds") or [])
    latest_state = updated.get("playbackState") or {}
    if participants.issubset(ready_ids):
        # Pause at the same future instant and account for time spent preparing,
        # so the saved position is the host's position at the actual pause edge.
        now_ms = int(time.time() * 1000)
        start_at = now_ms + 1200
        final_timestamp = float(latest_state.get("timestamp") or 0)
        if not latest_state.get("targetPlaying"):
            final_timestamp += max(0, (start_at - int(latest_state.get("commandAt") or now_ms)) / 1000)
        await database[db.ROOMS].update_one(
            {
                "_id": room["_id"],
                "playbackState.sequence": payload.sequence,
                "playbackState.phase": "preparing",
            },
            {"$set": {
                "playbackState.phase": "committed",
                "playbackState.playing": bool(latest_state.get("targetPlaying")),
                "playbackState.timestamp": final_timestamp,
                "playbackState.startAt": start_at,
                "playbackState.updatedAt": datetime.utcnow(),
            }},
        )
        updated = await get_room(database, room_id)

    await _broadcast_room_state(database, updated)
    return {"success": True, "data": await serialize_room(database, updated, user_id)}


@router.post("/{room_id}/queue")
async def add_queue_song(
    room_id: str,
    payload: QueueBody,
    current_user: dict = Depends(get_current_user),
):
    database = db.get_db()
    room = await _room_or_404(room_id)
    await require_member(database, room, current_user["id"])
    song = clean_song(payload.song)
    if song is None:
        raise HTTPException(status_code=400, detail="Invalid song.")
    if len(room.get("queue") or []) >= 100:
        raise HTTPException(status_code=409, detail="This room queue is full.")
    await database[db.ROOMS].update_one(
        {
            "_id": room["_id"],
            "queue.videoId": {"$ne": song["videoId"]},
            "currentTrack.videoId": {"$ne": song["videoId"]},
        },
        {"$push": {"queue": song}},
    )
    updated = await get_room(database, room_id)
    await _broadcast_room_state(database, updated)
    return {"success": True, "data": await serialize_room(database, updated, current_user["id"])}


@router.delete("/{room_id}/queue/{video_id}")
async def remove_queue_song(
    room_id: str,
    video_id: str,
    current_user: dict = Depends(get_current_user),
):
    database = db.get_db()
    room = await _room_or_404(room_id)
    await require_member(database, room, current_user["id"])
    if room.get("hostId") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Only the host can edit the queue.")
    await database[db.ROOMS].update_one(
        {"_id": room["_id"]}, {"$pull": {"queue": {"videoId": video_id}}}
    )
    updated = await get_room(database, room_id)
    await _broadcast_room_state(database, updated)
    return {"success": True, "data": await serialize_room(database, updated, current_user["id"])}


@router.post("/{room_id}/leave")
async def leave_room(room_id: str, payload: LeaveRoomBody | None = None, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    room = await _room_or_404(room_id)
    user_id = current_user["id"]
    await require_member(database, room, user_id)
    await database[PRESENCE_COLLECTION].delete_one({"roomId": room_id, "userId": user_id})
    if room.get("hostId") == user_id:
        if payload and payload.delete_room:
            await manager.broadcast_to_room(room_id, {"event": "room:closed", "data": {"roomId": room_id, "message": "The host ended this listening room."}})
            await database[db.ROOMS].delete_one({"_id": room["_id"]})
            await database[PRESENCE_COLLECTION].delete_many({"roomId": room_id})
            return {"success": True, "data": {"deleted": True}}
        return {"success": True, "data": {"deleted": False}}
    await database[db.ROOMS].update_one({"_id": room["_id"]}, {"$pull": {"members": user_id}})
    return {"success": True, "data": {"deleted": False}}


@router.delete("/{room_id}")
async def delete_room(room_id: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    room = await _room_or_404(room_id)
    if room.get("hostId") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Only the host can delete this room.")
    await manager.broadcast_to_room(room_id, {"event": "room:closed", "data": {"roomId": room_id, "message": "The host ended this listening room."}})
    await database[db.ROOMS].delete_one({"_id": room["_id"]})
    await database[PRESENCE_COLLECTION].delete_many({"roomId": room_id})
    return {"success": True, "message": "Room deleted."}
