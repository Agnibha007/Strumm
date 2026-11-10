"""MongoDB-backed domain helpers for listening rooms."""

from __future__ import annotations

import html
import math
import secrets
from datetime import datetime, timedelta
import time
import os
from typing import Any

from bson import ObjectId

from app.database import mongodb as db
from app.services.security import is_valid_youtube_id, sanitize_text

PRESENCE_TTL_SECONDS = 25
PRESENCE_COLLECTION = db.ROOM_PRESENCE


def new_join_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


def clean_song(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    video_id = value.get("videoId")
    if not is_valid_youtube_id(video_id):
        return None
    try:
        duration = float(value.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    if not math.isfinite(duration) or duration < 0 or duration > 86400:
        duration = 0
    thumbnail = html.unescape(sanitize_text(value.get("thumbnail"), max_length=1000))
    if not thumbnail.startswith("https://"):
        thumbnail = ""
    song = {
        "videoId": video_id.strip(),
        "title": html.unescape(sanitize_text(value.get("title"), max_length=200)),
        "artist": html.unescape(sanitize_text(value.get("artist"), max_length=200)),
        "thumbnail": thumbnail,
        "duration": duration,
    }
    metadata = value.get("metadata")
    audio_url = metadata.get("audioUrl") if isinstance(metadata, dict) else None
    if (
        os.getenv("ENVIRONMENT", "").lower() == "development"
        and os.getenv("STRUMM_DEV_AUTH", "").lower() == "true"
        and isinstance(audio_url, str)
        and audio_url.startswith(("http://127.0.0.1:8001/", "http://localhost:8001/"))
    ):
        song["metadata"] = {"audioUrl": audio_url}
    return song


async def get_room(database, room_id: str) -> dict | None:
    if not ObjectId.is_valid(room_id):
        return None
    return await database[db.ROOMS].find_one({"_id": ObjectId(room_id)})


async def active_presence(database, room_id: str) -> list[dict]:
    cutoff = datetime.utcnow() - timedelta(seconds=PRESENCE_TTL_SECONDS)
    cursor = database[PRESENCE_COLLECTION].find(
        {"roomId": room_id, "lastSeenAt": {"$gte": cutoff}},
        {"_id": 0, "userId": 1},
    )
    ids = []
    async for row in cursor:
        user_id = row.get("userId")
        if user_id and user_id not in ids:
            ids.append(user_id)
    if not ids:
        return []
    object_ids = [ObjectId(value) for value in ids if ObjectId.is_valid(value)]
    users = database[db.USERS].find(
        {"_id": {"$in": object_ids}},
        {"displayName": 1, "username": 1, "avatar": 1, "avatarMediaId": 1},
    )
    by_id = {}
    async for user in users:
        by_id[str(user["_id"])] = {
            "id": str(user["_id"]),
            "displayName": user.get("displayName") or user.get("username") or "Listener",
            "username": user.get("username") or "",
            "avatar": user.get("avatar"),
            "avatarMediaId": user.get("avatarMediaId"),
        }
    if (
        os.getenv("ENVIRONMENT", "").lower() == "development"
        and os.getenv("STRUMM_DEV_AUTH", "").lower() == "true"
    ):
        for user_id in ids:
            if user_id not in by_id and len(user_id) == 24:
                by_id[user_id] = {
                    "id": user_id,
                    "displayName": f"Local Guest {user_id[-4:]}",
                    "username": f"dev_{user_id[-6:]}",
                    "avatar": None,
                    "avatarMediaId": None,
                }
    return [by_id[user_id] for user_id in ids if user_id in by_id]


async def serialize_room(database, room: dict, viewer_id: str | None = None) -> dict:
    listeners = await active_presence(database, str(room["_id"]))
    playback_state = dict(room.get("playbackState") or {
        "playing": False, "timestamp": 0, "updatedAt": None,
        "startAt": None, "sequence": 0,
    })
    # Include a server clock sample so clients can compensate for device clock
    # skew when scheduling the shared play/pause edge.
    playback_state["serverNow"] = int(time.time() * 1000)
    return {
        "id": str(room["_id"]),
        "name": room.get("name", "Listening room"),
        "hostId": room.get("hostId"),
        "isHost": bool(viewer_id and room.get("hostId") == viewer_id),
        "hostName": room.get("hostName", "Host"),
        "members": room.get("members", []),
        "listeners": listeners,
        "listenerCount": len(listeners),
        "joinCode": room.get("joinCode"),
        "currentTrack": room.get("currentTrack"),
        "playbackState": playback_state,
        "queue": room.get("queue") or [],
        "createdAt": room.get("createdAt"),
    }


async def require_member(database, room: dict, user_id: str) -> None:
    from fastapi import HTTPException
    if user_id not in (room.get("members") or []) and room.get("hostId") != user_id:
        raise HTTPException(status_code=403, detail="Join this room before accessing it.")
