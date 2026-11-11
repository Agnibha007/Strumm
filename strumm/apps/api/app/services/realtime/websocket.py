"""
Global WebSocket endpoint — handles all non-room real-time events.

This endpoint is mounted at ``/ws`` and serves:
  - Presence (online / offline / listening)
  - Circle activity updates
  - Notifications
  - Player state sync
  - Heartbeat (ping / pong)

Authentication
--------------
The client sends an ``authenticate`` event as its first message carrying
the JWT.  The connection is rejected if authentication fails or no message
is received within 10 seconds.

"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder

from app.database import mongodb as db
from app.services.auth_utils import decode_access_token
from app.services.realtime.connection_manager import manager
from app.services.rooms import get_room, require_member, serialize_room
from app.services.realtime.events import (
    PING,
    PONG,
    AUTHENTICATE,
    USER_ONLINE,
    USER_OFFLINE,
    USER_LISTENING,
    USER_NOT_LISTENING,
    NOTIFICATION_CREATED,
)
from app.services.security import parse_object_id

logger = logging.getLogger("strumm-realtime-ws")
router = APIRouter()  # no prefix — mounted at /ws

# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


async def _verify_token(token: str) -> Optional[dict]:
    """Verify a JWT access token and return the user payload, or None.
    
    Rejects refresh tokens and other non-access token types.
    """
    if (
        os.getenv("ENVIRONMENT", "").lower() == "development"
        and os.getenv("STRUMM_DEV_AUTH", "").lower() == "true"
        and re.fullmatch(r"dev:[0-9a-fA-F]{24}", token or "")
    ):
        user_id = token.split(":", 1)[1].lower()
        return {"id": user_id, "sub": user_id, "type": "access", "dev": True}

    try:
        payload = decode_access_token(token)
        if payload is None:
            return None
        if payload.get("type") != "access":
            logger.warning("WS rejected — non-access token type: %s", payload.get("type"))
            return None
        return payload
    except Exception:
        return None


async def _update_last_active(user_id: str) -> None:
    """Update the user's ``lastActive`` timestamp in the database."""
    try:
        database = db.get_db()
        await database[db.USERS].update_one(
            {"_id": parse_object_id(user_id)},
            {"$set": {"lastActive": datetime.utcnow()}},
        )
    except Exception:
        pass


async def _broadcast_presence(user_id: str, event: str, user_data: dict) -> None:
    """Broadcast a presence event to the user's circle members."""
    try:
        database = db.get_db()
        # Fetch circle members
        cursor = database["connections"].find(
            {
                "$or": [{"requesterId": user_id}, {"receiverId": user_id}],
                "status": "accepted",
            }
        )
        member_ids: list[str] = []
        async for conn in cursor:
            friend_id = (
                conn["receiverId"]
                if conn["requesterId"] == user_id
                else conn["requesterId"]
            )
            member_ids.append(friend_id)

        if member_ids:
            await manager.broadcast_to_circle(
                member_ids,
                {"event": event, "data": user_data},
                exclude_user_id=user_id,
            )
    except Exception as exc:
        logger.warning("Failed to broadcast presence: %s", exc)


@router.websocket("/ws")
async def global_websocket_endpoint(
    websocket: WebSocket,
):
    """
    Global WebSocket — authenticated via the first message (``authenticate`` event).

    The client must send an ``authenticate`` event with ``{"event": "authenticate",
    "data": {"token": "<JWT>"}}`` as its first message within 10 seconds of
    connecting.  If authentication fails or no message is received within the
    timeout, the connection is closed.

    Once connected the client receives presence, activity, and notification
    events in real time.  The server sends ``ping`` every 30 seconds; the
    client must respond with ``pong`` within 10 seconds or the connection
    is closed.
    """
    # 1. Accept the connection first
    await websocket.accept()

    # 2. Wait for the authenticate message (10s timeout)
    token = None
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        if msg.get("event") != AUTHENTICATE:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        token = msg.get("data", {}).get("token")
        if not token:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
    except asyncio.TimeoutError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        logger.warning("WS rejected — no authenticate message received within 10s")
        return

    # 3. Authenticate
    payload = await _verify_token(token)
    if payload is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        logger.warning("WS rejected — invalid token")
        return

    user_id = payload.get("id") or payload.get("sub")
    if not user_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # 2. Register connection
    await manager.connect_user(user_id, websocket)
    subscribed_room_ids: set[str] = set()
    subscribed_room_host_ids: dict[str, str] = {}
    await _update_last_active(user_id)

    # Fetch user data for presence broadcast
    database = db.get_db()
    user_doc = await database[db.USERS].find_one({"_id": parse_object_id(user_id)})
    user_data = {
        "id": user_id,
        "displayName": user_doc.get("displayName", "Someone") if user_doc else "Someone",
        "username": user_doc.get("username") if user_doc else "",
        "avatar": user_doc.get("avatar") if user_doc else None,
    }

    # 3. Broadcast online to circle
    await _broadcast_presence(user_id, USER_ONLINE, user_data)

    # 4. Send a welcome event so the client knows the connection is ready
    await manager.send_json(websocket, {
        "event": "connected",
        "data": {"userId": user_id},
    })

    logger.info("WS connected — user=%s", user_id[:8])

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event = msg.get("event", "")
            event_data = msg.get("data", {})

            # --- Listening room subscriptions ---
            if event == "room:subscribe":
                room_id = str(event_data.get("roomId") or "").strip()
                room = await get_room(database, room_id)
                if not room:
                    await manager.send_json(websocket, {
                        "event": "room:error",
                        "data": {"roomId": room_id, "message": "Room not found."},
                    })
                    continue
                try:
                    await require_member(database, room, user_id)
                except HTTPException:
                    await manager.send_json(websocket, {
                        "event": "room:error",
                        "data": {"roomId": room_id, "message": "Join this room before subscribing."},
                    })
                    continue
                device_id = str(event_data.get("deviceId") or "").strip().lower()
                if not re.fullmatch(r"[0-9a-f]{32}", device_id):
                    await manager.send_json(websocket, {
                        "event": "room:error",
                        "data": {"roomId": room_id, "message": "Invalid device identity."},
                    })
                    continue
                if room_id not in subscribed_room_ids:
                    await manager.connect_room(room_id, user_id, websocket)
                    subscribed_room_ids.add(room_id)
                subscribed_room_host_ids[room_id] = str(room.get("hostId") or "")
                manager.set_room_device_id(room_id, websocket, device_id)
                snapshot = jsonable_encoder(await serialize_room(database, room, user_id))
                await manager.send_json(websocket, {
                    "event": "room:state",
                    "data": {"roomId": room_id, "room": snapshot},
                })
                peers = manager.room_connected_clients(room_id)
                await manager.broadcast_to_room(room_id, {
                    "event": "room:peers",
                    "data": {"roomId": room_id, "peers": peers},
                })
                continue

            if event == "room:unsubscribe":
                room_id = str(event_data.get("roomId") or "").strip()
                if room_id in subscribed_room_ids:
                    manager.disconnect_room(room_id, websocket)
                    subscribed_room_ids.discard(room_id)
                    subscribed_room_host_ids.pop(room_id, None)
                continue

            if event == "room:chat":
                room_id = str(event_data.get("roomId") or "").strip()
                message = str(event_data.get("message") or "").strip()
                if room_id not in subscribed_room_ids or not message or len(message) > 500:
                    continue
                room = await get_room(database, room_id)
                if not room:
                    continue
                try:
                    await require_member(database, room, user_id)
                except HTTPException:
                    continue
                await manager.broadcast_to_room(room_id, {
                    "event": "room:chat",
                    "data": {
                        "roomId": room_id,
                        "message": message,
                        "userId": user_id,
                        "displayName": user_data.get("displayName") or user_data.get("username") or "Listener",
                        "sentAt": datetime.utcnow().isoformat() + "Z",
                    },
                })
                continue

            if event == "room:signal":
                room_id = str(event_data.get("roomId") or "").strip()
                target_device_id = str(event_data.get("targetDeviceId") or "").strip().lower()
                signal = event_data.get("signal")
                signal_type = signal.get("type") if isinstance(signal, dict) else None
                signal_value = signal.get("value") if isinstance(signal, dict) else None
                source_device_id = manager.room_device_id(room_id, websocket)
                if (
                    room_id not in subscribed_room_ids
                    or not re.fullmatch(r"[0-9a-f]{32}", target_device_id)
                    or target_device_id == source_device_id
                    or signal_type not in {"offer", "answer", "candidate"}
                    or not isinstance(signal_value, dict)
                    or len(json.dumps(signal, separators=(",", ":"))) > 32768
                    or not source_device_id
                ):
                    continue
                target_client = next(
                    (
                        client for client in manager.room_connected_clients(room_id)
                        if client.get("deviceId") == target_device_id
                    ),
                    None,
                )
                if target_client is None:
                    continue
                room = await get_room(database, room_id)
                if not room:
                    continue
                try:
                    await require_member(database, room, user_id)
                    await require_member(database, room, str(target_client.get("userId") or ""))
                except HTTPException:
                    continue
                target = manager.room_websocket_for_device(room_id, target_device_id)
                if target is not None and target != websocket:
                    await manager.send_json(target, {
                        "event": "room:signal",
                        "data": {
                            "roomId": room_id,
                            "fromDeviceId": source_device_id,
                            "signal": signal,
                        },
                    })
                continue

            # --- Ping/Pong ---
            if event == PING:
                await manager.send_json(websocket, {"event": PONG})
                continue

            # --- Listening state (broadcast to circle) ---
            if event == USER_LISTENING:
                song = event_data.get("song", {})
                await _broadcast_presence(
                    user_id,
                    USER_LISTENING,
                    {
                        **user_data,
                        "song": {
                            "videoId": song.get("videoId"),
                            "title": song.get("title"),
                            "artist": song.get("artist"),
                            "thumbnail": song.get("thumbnail"),
                        },
                        "timestamp": datetime.utcnow().isoformat(),
                    },
                )
                continue

            if event == USER_NOT_LISTENING:
                await _broadcast_presence(
                    user_id, USER_NOT_LISTENING, user_data
                )
                continue

            # --- Player state (sync to other devices) ---
            if event == "player:sync":
                # Forward to other connections for the same user
                connections = manager.get_user_connections(user_id)
                for ws in connections:
                    if ws != websocket:
                        await manager.send_json(ws, {
                            "event": "player:state",
                            "data": event_data,
                        })
                continue

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WS error for user=%s: %s", user_id[:8], exc)
    finally:
        # 5. Deregister connection
        for room_id in subscribed_room_ids:
            manager.disconnect_room(room_id, websocket)
        manager.disconnect_user(user_id, websocket)
        await _update_last_active(user_id)

        # 6. Broadcast offline to circle if this was the last connection
        if not manager.is_user_online(user_id):
            await _broadcast_presence(user_id, USER_OFFLINE, user_data)
            logger.info("WS disconnected — user=%s (fully offline)", user_id[:8])
