"""
Strumm Rooms — REST + WebSocket.

Mounted at ``/social`` (same wire paths the legacy ``social.py`` routes used),
so existing clients keep working unchanged::

    GET    /social/rooms            list rooms (public + host + member)
    POST   /social/rooms            create a room
    GET    /social/rooms/search     search rooms by name
    GET    /social/rooms/suggestions   fresh public rooms
    GET    /social/rooms/{roomId}   room detail (+ member profiles)
    POST   /social/rooms/{roomId}/invite       host invites a circle friend
    POST   /social/rooms/{roomId}/leave        leave the room cleanly
    POST   /social/rooms/{roomId}/kick         host kicks a listener
    POST   /social/rooms/{roomId}/join-code    host regenerates the join code
    DELETE /social/rooms/{roomId}   host deletes the room
    WS     /social/rooms/{roomId}/ws           room sync / voice signalling

All domain logic (access/control gates, lifecycle, queue ops, join codes,
notifications) lives in ``app/services/rooms.py``; this module only wires it
to HTTP + WebSocket.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status

from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.auth_utils import decode_access_token
from app.services.avatar import decorate_user_avatar
from app.services.realtime.events import (
    ROOM_CONTROLLERS_UPDATED,
    ROOM_HOST_TRANSFERRED,
    ROOM_INVITED,
    ROOM_JOINED,
    ROOM_KICKED,
    ROOM_LEFT,
    ROOM_STATE,
    QUEUE_ADDED,
    QUEUE_REMOVED,
    QUEUE_CLEARED,
)
from app.services.rooms import (
    RoomCreateRequest,
    RoomInviteRequest,
    RoomKickRequest,
    batch_fetch_host_names,
    build_member_profiles,
    can_access_room,
    can_control,
    circle_user_ids,
    ensure_join_code,
    fetch_host_name,
    find_room_by_join_code,
    generate_join_code,
    handle_room_disconnect,
    is_circle_member,
    manager as realtime_manager,
    notify_room_created,
    notify_room_deleted,
    notify_room_updated,
    queue_clear,
    queue_push,
    queue_remove,
    serialize_room,
)
logger = logging.getLogger("strumm-rooms")
router = APIRouter(prefix="/social/rooms", tags=["rooms"])

# Delegate room WebSocket management to the centralized realtime manager
ws_manager = realtime_manager


async def _get_room_or_404(database, room_id: str, detail: str = "Strumm Room not found.") -> dict:
    if not ObjectId.is_valid(room_id):
        raise HTTPException(status_code=404, detail=detail)
    room = await database[db.ROOMS].find_one({"_id": ObjectId(room_id)})
    if not room:
        raise HTTPException(status_code=404, detail=detail)
    return room


# ---------------------------------------------------------------------------
# List / create
# ---------------------------------------------------------------------------


@router.get("")
async def list_rooms(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]

    # Only public rooms, rooms the user hosts, and rooms the user is a member of.
    cursor = database[db.ROOMS].find({
        "$or": [
            {"visibility": "public"},
            {"hostId": my_id},
            {"members": my_id},
        ]
    }).sort("createdAt", -1)

    raw_rooms = await cursor.to_list(length=500)
    host_ids = [r.get("hostId") for r in raw_rooms]
    host_names = await batch_fetch_host_names(database, host_ids)

    rooms_list = [
        serialize_room(r, host_names.get(r.get("hostId"), "Unknown"))
        for r in raw_rooms
    ]
    return {"success": True, "data": rooms_list}


@router.post("")
async def create_room(payload: RoomCreateRequest, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]

    from app.services.security import sanitize_text

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
        "controllers": [my_id],
        "visibility": payload.visibility if payload.visibility in {"public", "circle"} else "public",
        "joinCode": generate_join_code(),
        "createdAt": datetime.utcnow()
    }

    res = await database[db.ROOMS].insert_one(new_room)
    new_room["id"] = str(res.inserted_id)
    del new_room["_id"]
    new_room["hostName"] = current_user.get("displayName", "Someone")
    await notify_room_created(database, new_room, host_name=new_room["hostName"])
    return {"success": True, "data": new_room}


# ---------------------------------------------------------------------------
# Search / suggestions / join-by-code
# ---------------------------------------------------------------------------


@router.get("/search")
async def search_rooms(q: str = "", current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]

    from app.services.security import sanitize_text
    import re

    query = sanitize_text(q, max_length=100).strip()
    if not query:
        return {"success": True, "query": "", "data": []}

    # Mirror of the list filter: only rooms the caller may actually see.
    cursor = database[db.ROOMS].find({
        "$and": [
            {
                "$or": [
                    {"visibility": "public"},
                    {"hostId": my_id},
                    {"members": my_id},
                ]
            },
            {"name": {"$regex": re.escape(query), "$options": "i"}},
        ]
    }).limit(50)
    raw_rooms = await cursor.to_list(length=50)
    host_names = await batch_fetch_host_names(database, [r.get("hostId") for r in raw_rooms])
    return {
        "success": True,
        "query": query,
        "data": [
            serialize_room(r, host_names.get(r.get("hostId"), "Unknown"))
            for r in raw_rooms
        ],
    }


@router.get("/suggestions")
async def suggest_rooms(current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    my_id = current_user["id"]

    # Fresh public rooms the user isn't hosting or already a member of.
    cursor = database[db.ROOMS].find({
        "$and": [
            {"visibility": "public"},
            {"hostId": {"$ne": my_id}},
            {"members": {"$ne": my_id}},
        ]
    }).sort("createdAt", -1).limit(12)
    raw_rooms = await cursor.to_list(length=12)
    host_names = await batch_fetch_host_names(database, [r.get("hostId") for r in raw_rooms])

    suggestions = [
        serialize_room(r, host_names.get(r.get("hostId"), "Unknown"))
        for r in raw_rooms
    ]
    return {"success": True, "data": suggestions}


@router.get("/by-code/{code}")
async def get_room_by_code(code: str, current_user: dict = Depends(get_current_user)):
    """Resolve a shareable join code (``K7JX2M``) to a room's id + name.

    Enables the "Enter with code" flow without leaking the full room payload
    until the joining user is a member of the room.
    """
    database = db.get_db()
    room = await find_room_by_join_code(database, code)
    if not room:
        raise HTTPException(status_code=404, detail="No room found for that code.")

    host_name = await fetch_host_name(database, room.get("hostId"), default="Someone")
    return {
        "success": True,
        "data": {
            "id": str(room.get("_id")),
            "name": room.get("name"),
            "hostName": host_name,
            "visibility": room.get("visibility"),
            "memberCount": len(room.get("members") or []),
        },
    }


# ---------------------------------------------------------------------------
# Room detail / invite / leave / kick / join-code regen / delete
# ---------------------------------------------------------------------------


@router.get("/{roomId}")
async def get_room(roomId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    room = await _get_room_or_404(database, roomId)

    if not await can_access_room(database, room, current_user["id"]):
        raise HTTPException(status_code=403, detail="You don't have access to this room.")

    members_profiles = await build_member_profiles(database, room.get("members") or [])
    host_name = await fetch_host_name(database, room.get("hostId"), default="Someone")
    await ensure_join_code(database, room)

    payload = serialize_room(room, host_name=host_name)
    payload["membersProfiles"] = members_profiles
    return {"success": True, "data": payload}


@router.post("/{roomId}/invite")
async def invite_to_room(
    roomId: str,
    payload: RoomInviteRequest,
    current_user: dict = Depends(get_current_user),
):
    database = db.get_db()
    my_id = current_user["id"]

    from app.services.security import sanitize_text

    target_id = sanitize_text(payload.userId, max_length=64)
    if not ObjectId.is_valid(target_id):
        raise HTTPException(status_code=404, detail="Invited user not found.")

    room = await _get_room_or_404(database, roomId)
    if room.get("hostId") != my_id:
        raise HTTPException(status_code=403, detail="Only the room host can invite listeners.")
    if target_id == my_id:
        raise HTTPException(status_code=400, detail="You cannot invite yourself.")

    # Only current Circle friends can be invited directly into a room.
    if not await is_circle_member(database, my_id, target_id):
        raise HTTPException(status_code=403, detail="You can only invite Circle friends.")

    await database[db.ROOMS].update_one(
        {"_id": ObjectId(roomId)},
        {"$addToSet": {"invited": target_id}}
    )

    notification = {
        "userId": target_id,
        "type": "room_invite",
        "senderId": my_id,
        "senderName": current_user.get("displayName", "Someone"),
        "senderAvatar": current_user.get("avatar"),
        "roomId": roomId,
        "roomName": room.get("name", "A Strumm Room"),
        "read": False,
        "createdAt": datetime.utcnow()
    }
    await database[db.NOTIFICATIONS].insert_one(notification)

    await ws_manager.send_to_user(target_id, {
        "event": ROOM_INVITED,
        "data": {
            "roomId": roomId,
            "roomName": room.get("name", "A Strumm Room"),
            "hostId": my_id,
            "hostName": current_user.get("displayName", "Someone"),
        }
    })

    return {
        "success": True,
        "message": f"{current_user.get('displayName', 'You')} invited a listener to the room.",
    }


@router.post("/{roomId}/leave")
async def leave_room(roomId: str, current_user: dict = Depends(get_current_user)):
    """Leave a room cleanly (disconnect room sockets + run lifecycle cleanup).

    Mirrors the WS-disconnect path so a client that navigated away without
    closing its socket still becomes a room:left broadcast.
    """
    database = db.get_db()
    room = await _get_room_or_404(database, roomId, detail="Strumm Room not found.")
    my_id = current_user["id"]

    if my_id not in (room.get("members") or []) and room.get("hostId") != my_id:
        raise HTTPException(status_code=400, detail="You are not a member of this room.")

    room_id_str = str(room["_id"])
    # Drop any live room sockets first so the lifecycle cleanup sees an empty slot.
    ws_manager.disconnect_user_from_room(room_id_str, my_id)
    await handle_room_disconnect(room_id_str, my_id)

    return {"success": True, "message": "Left the room."}


@router.post("/{roomId}/kick")
async def kick_member(
    roomId: str,
    payload: RoomKickRequest,
    current_user: dict = Depends(get_current_user),
):
    """Host kicks a listener out of the room (broadcasts room:kicked)."""
    database = db.get_db()
    my_id = current_user["id"]

    from app.services.security import sanitize_text

    target_id = sanitize_text(payload.userId, max_length=64)
    room = await _get_room_or_404(database, roomId)

    if room.get("hostId") != my_id:
        raise HTTPException(status_code=403, detail="Only the room host can kick listeners.")
    if target_id == my_id:
        raise HTTPException(status_code=400, detail="You cannot kick yourself.")
    if target_id not in (room.get("members") or []):
        raise HTTPException(status_code=404, detail="That listener is not in the room.")

    room_id_str = str(room["_id"])

    # Broadcast the kick to everyone in the room; the client for the kicked
    # user reacts by leaving (navigating home) while others just see them go.
    from app.services.rooms import fetch_user_doc
    target_doc = await fetch_user_doc(database, target_id)
    target_name = target_doc.get("displayName", "Someone") if target_doc else "Someone"

    await ws_manager.broadcast_to_room(
        room_id=room_id_str,
        message={
            "event": ROOM_KICKED,
            "data": {"userId": target_id, "displayName": target_name, "byHostId": my_id},
        },
    )

    # Remove their live room sockets, then run the standard leave lifecycle
    # (room:left broadcast + member removal; host transfer is impossible since
    # a host may never kick themselves).
    ws_manager.disconnect_user_from_room(room_id_str, target_id)
    await handle_room_disconnect(room_id_str, target_id)

    return {"success": True, "message": f"Kicked {target_name} from the room."}


@router.post("/{roomId}/join-code")
async def regenerate_join_code(roomId: str, current_user: dict = Depends(get_current_user)):
    """Host regenerates the room's shareable join code."""
    database = db.get_db()
    room = await _get_room_or_404(database, roomId)

    if room.get("hostId") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Only the room host can change the join code.")

    new_code = generate_join_code()
    await database[db.ROOMS].update_one(
        {"_id": room["_id"]}, {"$set": {"joinCode": new_code}}
    )
    return {"success": True, "data": {"joinCode": new_code}}


@router.delete("/{roomId}")
async def delete_room(roomId: str, current_user: dict = Depends(get_current_user)):
    database = db.get_db()
    room = await _get_room_or_404(database, roomId)

    if room.get("hostId") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Only the room host can delete this room.")

    room_id_str = str(room["_id"])
    await notify_room_deleted(database, room, room_id_str)
    await database[db.ROOMS].delete_one({"_id": room["_id"]})

    return {"success": True, "message": "Room deleted successfully."}


# ---------------------------------------------------------------------------
# Room WebSocket — sync + voice signalling
# ---------------------------------------------------------------------------


@router.websocket("/{roomId}/ws")
async def room_websocket_endpoint(websocket: WebSocket, roomId: str):
    # Validate the room id before doing anything else.
    if not ObjectId.is_valid(roomId):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid room")
        return
    room_oid = ObjectId(roomId)

    # Authenticate via JWT access token from Sec-WebSocket-Protocol header
    # Using the subprotocol header instead of query parameter to prevent
    # token leakage in server access logs and Referer headers.
    token = None
    protocols = websocket.headers.get("sec-websocket-protocol", "")
    if protocols:
        for p in protocols.split(","):
            p = p.strip()
            if p and p != "authorization":
                token = p
                break

    if not token:
        # Fallback: check query parameter (backward compatibility).
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

    database = db.get_db()

    # Enforce room access rules server-side (never trust the browser's room data).
    room = await database[db.ROOMS].find_one({"_id": room_oid})
    if not room:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Room not found")
        return
    if not await can_access_room(database, room, userId):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Not allowed in this room")
        return

    # MUST accept before sending/receiving any frames.
    await websocket.accept()
    await ws_manager.connect_room(roomId, userId, websocket)

    # Update room member lists
    await database[db.ROOMS].update_one(
        {"_id": room_oid},
        {"$addToSet": {"members": userId}}
    )

    # Broadcast join (with profile data so clients need no refetch)
    from app.services.rooms import fetch_user_doc
    join_data = {"userId": userId}
    user_doc = await fetch_user_doc(database, userId)
    if user_doc:
        await decorate_user_avatar(user_doc)
        join_data["displayName"] = user_doc.get("displayName", "Someone")
        join_data["avatar"] = user_doc.get("avatar")
    else:
        join_data["displayName"] = "Someone"
        join_data["avatar"] = None

    # Send the joining user a full room:state snapshot so they sync instantly
    # without a follow-up GET round-trip (track, playback, queue, members).
    await ensure_join_code(database, room)
    host_name = await fetch_host_name(database, room.get("hostId"), default="Someone")
    members_profiles = await build_member_profiles(database, room.get("members") or [])
    await ws_manager.send_json(websocket, {
        "event": ROOM_STATE,
        "data": {
            "currentTrack": room.get("currentTrack"),
            "playbackState": room.get("playbackState"),
            "queue": room.get("queue") or [],
            "hostId": room.get("hostId"),
            "hostName": host_name,
            "controllers": room.get("controllers") or [],
            "visibility": room.get("visibility"),
            "joinCode": room.get("joinCode"),
            "membersProfiles": members_profiles,
        },
    })

    await ws_manager.broadcast_to_room(
        room_id=roomId,
        message={"event": ROOM_JOINED, "data": join_data},
        exclude_user_id=userId
    )

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            event = payload.get("event")
            event_data = payload.get("data", {})

            if event == "track:update":
                # Only the host or approved controllers can change the room track.
                perm = await can_control(database, roomId, userId)
                if not perm["allowed"]:
                    await ws_manager.send_json(websocket, {
                        "event": "control:denied",
                        "data": {"reason": perm["reason"]},
                    })
                    continue
                await database[db.ROOMS].update_one(
                    {"_id": room_oid},
                    {"$set": {"currentTrack": event_data.get("song")}}
                )
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": "track:update", "data": event_data},
                    exclude_user_id=userId
                )

            elif event in {"play", "pause", "seek"}:
                perm = await can_control(database, roomId, userId)
                if not perm["allowed"]:
                    await ws_manager.send_json(websocket, {
                        "event": "control:denied",
                        "data": {"reason": perm["reason"]},
                    })
                    continue
                playback_state = {
                    "playing": event == "play",
                    "timestamp": event_data.get("timestamp", 0.0),
                    "updatedAt": datetime.utcnow()
                }
                await database[db.ROOMS].update_one(
                    {"_id": room_oid},
                    {"$set": {"playbackState": playback_state}}
                )
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": event, "data": event_data},
                    exclude_user_id=userId
                )

            elif event == "queue:add":
                # Collaborative queue: any member may push a song.
                song = await queue_push(database, room_oid, event_data.get("song"))
                if song is None:
                    continue
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": QUEUE_ADDED, "data": {"song": song, "addedBy": userId}},
                )

            elif event == "queue:remove":
                # Host/controllers may remove a song from the queue.
                perm = await can_control(database, roomId, userId)
                if not perm["allowed"]:
                    await ws_manager.send_json(websocket, {
                        "event": "control:denied",
                        "data": {"reason": perm["reason"]},
                    })
                    continue
                video_id = event_data.get("videoId")
                if not video_id:
                    continue
                await queue_remove(database, room_oid, video_id)
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": QUEUE_REMOVED, "data": {"videoId": video_id}},
                )

            elif event == "queue:clear":
                # Host/controllers may clear the whole queue.
                perm = await can_control(database, roomId, userId)
                if not perm["allowed"]:
                    await ws_manager.send_json(websocket, {
                        "event": "control:denied",
                        "data": {"reason": perm["reason"]},
                    })
                    continue
                await queue_clear(database, room_oid)
                await ws_manager.broadcast_to_room(
                    room_id=roomId,
                    message={"event": QUEUE_CLEARED, "data": {}},
                )

            elif event == "room:controller-add":
                # Host-only: grant control to another member.
                perm = await can_control(database, roomId, userId)
                target = event_data.get("userId")
                if not perm["allowed"]:
                    await ws_manager.send_json(websocket, {
                        "event": "control:denied",
                        "data": {"reason": perm["reason"]},
                    })
                elif target and target != userId and ObjectId.is_valid(str(target)):
                    await database[db.ROOMS].update_one(
                        {"_id": room_oid},
                        {"$addToSet": {"controllers": target}}
                    )
                    updated = await database[db.ROOMS].find_one({"_id": room_oid})
                    await ws_manager.broadcast_to_room(
                        room_id=roomId,
                        message={"event": ROOM_CONTROLLERS_UPDATED,
                                 "data": {"controllers": updated.get("controllers") or []}},
                    )

            elif event == "room:controller-remove":
                perm = await can_control(database, roomId, userId)
                target = event_data.get("userId")
                if not perm["allowed"]:
                    await ws_manager.send_json(websocket, {
                        "event": "control:denied",
                        "data": {"reason": perm["reason"]},
                    })
                elif target and target != userId:
                    await database[db.ROOMS].update_one(
                        {"_id": room_oid},
                        {"$pull": {"controllers": target}}
                    )
                    updated = await database[db.ROOMS].find_one({"_id": room_oid})
                    await ws_manager.broadcast_to_room(
                        room_id=roomId,
                        message={"event": ROOM_CONTROLLERS_UPDATED,
                                 "data": {"controllers": updated.get("controllers") or []}},
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
        pass
    except Exception as exc:
        logger.error("Room WS error (room=%s user=%s): %s", roomId, userId[:8], exc)
        import sentry_sdk
        sentry_sdk.capture_exception(exc)
    finally:
        ws_manager.disconnect_room(roomId, websocket)
        await handle_room_disconnect(roomId, userId)