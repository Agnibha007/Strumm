"""
Room domain logic for Strumm Rooms.

Centralizes the room data model, serialization, access/control gates, room
lifecycle (host transfer + hostless zombie cleanup), circle notifications,
join codes, and collaborative queue mutations. Both the REST layer
(``app/routes/rooms.py``) and the room WebSocket handler delegate here so no
domain logic lives inside a router.

Naming note
-----------
Event names must stay aligned with ``app/services/realtime/events.py`` (the
single source of truth for wire events). If a name changes here, update both
the server broadcast and every client handler in ``apps/web``.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime
from typing import Any, Optional

from bson import ObjectId
from pydantic import BaseModel

from app.database import mongodb as db
from app.services.avatar import decorate_user_avatar
from app.services.realtime.connection_manager import manager as realtime_manager
from app.services.realtime.events import (
    ROOM_CONTROLLERS_UPDATED,
    ROOM_CREATED,
    ROOM_DELETED,
    ROOM_HOST_TRANSFERRED,
    ROOM_INVITED,
    ROOM_LEFT,
    ROOM_UPDATED,
)

logger = logging.getLogger("strumm-rooms")

# Manager used for room channel + circle broadcasts (alias keeps tests simple).
manager = realtime_manager

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class RoomCreateRequest(BaseModel):
    name: str
    visibility: str = "public"  # public, circle


class RoomInviteRequest(BaseModel):
    userId: str


class RoomKickRequest(BaseModel):
    userId: str


# ---------------------------------------------------------------------------
# Join codes
# ---------------------------------------------------------------------------

# Ambiguity-free alphabet (no 0/O/1/I/l).
_JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_JOIN_CODE_LENGTH = 6


def generate_join_code() -> str:
    """Generate a short, shareable room join code (e.g. ``K7JX2M``)."""
    return "".join(secrets.choice(_JOIN_CODE_ALPHABET) for _ in range(_JOIN_CODE_LENGTH))


async def ensure_join_code(database, room: dict) -> str:
    """Return the room's join code, backfilling it if the doc predates codes."""
    code = room.get("joinCode")
    if code:
        return code
    code = generate_join_code()
    await database[db.ROOMS].update_one(
        {"_id": room["_id"]}, {"$set": {"joinCode": code}}
    )
    room["joinCode"] = code
    return code


async def find_room_by_join_code(database, code: str) -> Optional[dict]:
    """Resolve a join code to a room document (uppercased, trimmed)."""
    cleaned = "".join(code.split()).upper()
    if not cleaned:
        return None
    return await database[db.ROOMS].find_one({"joinCode": cleaned})


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def serialize_room(room: dict, host_name: str = "", controllers: Optional[list] = None) -> dict:
    """Flatten a room document for the API (id as string, hostName resolved)."""
    payload: dict = {}
    for key in ("name", "hostId", "members", "currentTrack", "playbackState",
                "queue", "visibility", "createdAt", "controllers", "joinCode"):
        if key in room and room[key] is not None:
            payload[key] = room[key]
    if controllers is not None:
        payload["controllers"] = controllers
    payload["id"] = str(room.get("_id", ""))
    payload["hostName"] = host_name or "Unknown"
    return payload


# ---------------------------------------------------------------------------
# User / host resolution (kills N+1)
# ---------------------------------------------------------------------------


async def fetch_user_doc(database, user_id: str) -> Optional[dict]:
    """Fetch a user document by id, tolerating ObjectId and plain-string ids."""
    if not user_id:
        return None
    if ObjectId.is_valid(str(user_id)):
        return await database[db.USERS].find_one({"_id": ObjectId(str(user_id))})
    return await database[db.USERS].find_one({"_id": user_id})


async def fetch_host_name(database, host_id: str, default: str = "Unknown") -> str:
    user = await fetch_user_doc(database, host_id)
    return user.get("displayName", "Someone") if user else default


async def batch_fetch_host_names(database, host_ids: list) -> dict:
    """Resolve a batch of hostIds to displayNames in a single query (kills N+1)."""
    names: dict = {}
    valid_ids, via_str_ids = [], []
    for h in host_ids:
        if not h:
            continue
        if ObjectId.is_valid(str(h)):
            valid_ids.append(str(h))
        else:
            via_str_ids.append(str(h))

    if valid_ids:
        obj_ids = [ObjectId(v) for v in valid_ids]
        users = await database[db.USERS].find(
            {"_id": {"$in": obj_ids}}
        ).to_list(length=len(valid_ids))
        for u in users:
            names[str(u["_id"])] = u.get("displayName", "Someone")
    for h in via_str_ids:
        u = await database[db.USERS].find_one({"_id": h})
        if u:
            names[h] = u.get("displayName", "Someone")
    return names


async def build_member_profiles(database, member_ids: list) -> list:
    """Resolve member ids to ``{id, displayName, avatar}`` in one batched query."""
    profiles: list = []
    if not member_ids:
        return profiles

    object_members = [ObjectId(m) for m in member_ids if ObjectId.is_valid(m)]
    str_members = [m for m in member_ids if m and not ObjectId.is_valid(m)]

    by_id: dict = {}
    if object_members:
        m_users = await database[db.USERS].find(
            {"_id": {"$in": object_members}}
        ).to_list(length=len(object_members))
        for mu in m_users:
            by_id[str(mu["_id"])] = mu
    for sid in str_members:
        mu = await database[db.USERS].find_one({"_id": sid})
        if mu:
            by_id[sid] = mu

    for mid in member_ids:
        m_user = by_id.get(mid)
        if m_user:
            await decorate_user_avatar(m_user)
            profiles.append({
                "id": mid,
                "displayName": m_user.get("displayName", "Someone"),
                "avatar": m_user.get("avatar"),
            })
    return profiles


# ---------------------------------------------------------------------------
# Circle helpers
# ---------------------------------------------------------------------------


async def circle_user_ids(database, user_id: str) -> list:
    """IDs of all accepted circle members of ``user_id`` (does not include self)."""
    conns = await database[db.CONNECTIONS].find({
        "$or": [{"requesterId": user_id}, {"receiverId": user_id}],
        "status": "accepted"
    }).to_list(length=200)
    return [
        c["receiverId"] if c["requesterId"] == user_id else c["requesterId"]
        for c in conns
    ]


async def is_circle_member(database, user_id: str, other_id: str) -> bool:
    """Whether ``user_id`` is an accepted circle member of ``other_id``."""
    conn = await database[db.CONNECTIONS].find_one({
        "$or": [
            {"requesterId": user_id, "receiverId": other_id},
            {"requesterId": other_id, "receiverId": user_id},
        ],
        "status": "accepted",
    })
    return bool(conn)


# ---------------------------------------------------------------------------
# Access + control gates
# ---------------------------------------------------------------------------


async def can_access_room(database, room: dict, user_id: str) -> bool:
    """Access check for a single room. Circle rooms are limited to the circle.

    Invited users (``room.invited``) may enter even non-public rooms.
    """
    if room.get("visibility") != "circle":
        return True
    if room.get("hostId") == user_id or user_id in (room.get("members") or []):
        return True
    if user_id in (room.get("invited") or []):
        return True
    return await is_circle_member(database, user_id, room.get("hostId"))


async def can_control(database, room_id: str, user_id: str) -> dict:
    """Whether ``user_id`` may send control events (track/play/pause/seek)."""
    if not ObjectId.is_valid(str(room_id)):
        return {"allowed": False, "reason": "Room not found."}
    room = await database[db.ROOMS].find_one({"_id": ObjectId(str(room_id))})
    if not room:
        return {"allowed": False, "reason": "Room not found."}
    if room.get("hostId") == user_id:
        return {"allowed": True, "reason": ""}
    if user_id in (room.get("controllers") or []):
        return {"allowed": True, "reason": ""}
    return {
        "allowed": False,
        "reason": "Only the room host or approved controllers can change playback.",
    }


# ---------------------------------------------------------------------------
# Collaborative queue mutations
# ---------------------------------------------------------------------------


async def queue_push(database, room_oid: ObjectId, song: dict) -> Optional[dict]:
    """Append a song to the room queue. Returns the appended song or None."""
    if not song or not song.get("videoId"):
        return None
    await database[db.ROOMS].update_one(
        {"_id": room_oid},
        {"$push": {"queue": song}}
    )
    return song


async def queue_remove(database, room_oid: ObjectId, video_id: str) -> int:
    """Remove all queue entries matching a videoId. Returns how many removed."""
    selected = getattr(video_id, "strip", lambda: video_id)
    result = await database[db.ROOMS].update_one(
        {"_id": room_oid},
        {"$pull": {"queue": {"videoId": selected()}}}
    )
    return (result.modified_count or 0)


async def queue_clear(database, room_oid: ObjectId) -> None:
    await database[db.ROOMS].update_one(
        {"_id": room_oid},
        {"$set": {"queue": []}}
    )


# ---------------------------------------------------------------------------
# Room lifecycle
# ---------------------------------------------------------------------------


async def remove_member(database, room: dict, user_id: str) -> None:
    """Remove a user from a room's member + controller lists in the DB."""
    await database[db.ROOMS].update_one(
        {"_id": room["_id"]},
        {"$pull": {"members": user_id}, "$pull": {"controllers": user_id}}
    )


async def handle_room_disconnect(room_id: str, user_id: str) -> None:
    """
    Room WebSocket cleanup: broadcast room:left, remove the member, and — if the
    host left — auto-transfer host to the longest-connected remaining member.
    An empty room with no host candidate is deleted to avoid hostless zombies.
    """
    if not ObjectId.is_valid(str(room_id)):
        return
    database = db.get_db()
    oid = ObjectId(str(room_id))
    try:
        room = await database[db.ROOMS].find_one({"_id": oid})
        if not room:
            return
        room_id_str = str(room["_id"])

        # Derive the data payload from the leaving user (best-effort).
        try:
            leaver_name = await fetch_host_name(database, user_id, default="Someone")
        except Exception:
            leaver_name = "Someone"

        await manager.broadcast_to_room(
            room_id=room_id_str,
            message={"event": ROOM_LEFT, "data": {"userId": user_id, "displayName": leaver_name}},
            exclude_user_id=user_id,
        )

        await remove_member(database, room, user_id)
        room["members"] = [m for m in (room.get("members") or []) if m != user_id]

        if room.get("hostId") != user_id:
            return

        remaining = manager.room_connected_user_ids(room_id_str)
        if remaining:
            new_host_id = remaining[0]
            new_host_name = await fetch_host_name(database, new_host_id, default="Someone")
            await database[db.ROOMS].update_one(
                {"_id": oid}, {"$set": {"hostId": new_host_id}}
            )
            room["hostId"] = new_host_id
            await manager.broadcast_to_room(
                room_id=room_id_str,
                message={
                    "event": ROOM_HOST_TRANSFERRED,
                    "data": {"hostId": new_host_id, "hostName": new_host_name},
                },
            )
            await notify_room_updated(database, room, host_name=new_host_name)
        else:
            await database[db.ROOMS].delete_one({"_id": oid})
            await notify_room_deleted(database, room, room_id_str)
    except Exception as exc:
        import traceback
        logger.error(
            "Room disconnect cleanup failed (room=%s): %s\n%s",
            room_id, exc, traceback.format_exc(),
        )
        import sentry_sdk
        sentry_sdk.capture_exception(exc)


# ---------------------------------------------------------------------------
# Notifications (pushed to the host's circle on the global /ws channel)
# ---------------------------------------------------------------------------


async def notify_room_created(database, room: dict, host_name: str = "Someone") -> None:
    data = {
        "roomId": str(room.get("_id") or room.get("id")),
        "name": room.get("name"),
        "hostId": room.get("hostId"),
        "hostName": host_name,
        "visibility": room.get("visibility"),
        "memberCount": len(room.get("members") or []),
    }
    member_ids = await circle_user_ids(database, room.get("hostId"))
    if member_ids:
        await manager.broadcast_to_circle(member_ids, {"event": ROOM_CREATED, "data": data})
    await manager.send_to_user(room.get("hostId"), {"event": ROOM_CREATED, "data": data})


async def notify_room_updated(database, room: dict, host_name: str = None) -> None:
    data = {
        "roomId": str(room.get("_id") or room.get("id")),
        "name": room.get("name"),
        "hostId": room.get("hostId"),
        "hostName": host_name or await fetch_host_name(database, room.get("hostId"), default="Someone"),
        "visibility": room.get("visibility"),
        "memberCount": len(room.get("members") or []),
    }
    member_ids = await circle_user_ids(database, room.get("hostId"))
    if member_ids:
        await manager.broadcast_to_circle(member_ids, {"event": ROOM_UPDATED, "data": data})
    await manager.send_to_user(room.get("hostId"), {"event": ROOM_UPDATED, "data": data})


async def notify_room_deleted(database, room: dict, room_id_str: str) -> None:
    data = {"roomId": room_id_str}
    await manager.broadcast_to_room(
        room_id=room_id_str,
        message={"event": ROOM_DELETED, "data": data},
    )
    host_id = room.get("hostId")
    member_ids = await circle_user_ids(database, host_id)
    if member_ids:
        await manager.broadcast_to_circle(member_ids, {"event": ROOM_DELETED, "data": data})
    await manager.send_to_user(host_id, {"event": ROOM_DELETED, "data": data})


# ---------------------------------------------------------------------------
# Legacy data cleanup (idempotent, safe to run on every boot)
# ---------------------------------------------------------------------------


async def cleanup_legacy_rooms(database) -> dict:
    """Normalize/drop legacy room documents so the extracted room service never
    trips over old data.

    Legacy rooms (created before the rooms service landed) can carry:
      * no ``joinCode`` field -- backfilled here so ``/by-code`` + snapshots work
      * duplicate or stale ``members``/``controllers`` ids (accounts deleted)
      * an orphaned host id (account gone -> room permanently unmanageable)
      * a fully-empty member list (crash left nobody behind -> unreachable)
      * dangling ``room_invite`` notifications pointing at deleted rooms

    Idempotent: each pass only repairs structural garbage and backfills missing
    join codes; it never touches live rooms with a valid host and members.
    Returns per-action counts for startup logging.
    """
    if not database or database is None:
        return {}
    rooms = database[db.ROOMS]
    users = database[db.USERS]
    notifications = database[db.NOTIFICATIONS]

    stats = {
        "backfilledJoinCodes": 0,
        "prunedMembers": 0,
        "prunedControllers": 0,
        "deletedHostless": 0,
        "deletedEmpty": 0,
        "removedStaleInvites": 0,
    }
    live_room_ids: set[str] = set()
    deleted_room_ids: set[str] = set()

    async for room in rooms.find({}):
        room_oid = room.get("_id")
        if not room_oid:
            continue
        room_id_str = str(room_oid)

        # 1. Legacy docs predate join codes -> backfill a fresh one.
        if not room.get("joinCode"):
            await rooms.update_one(
                {"_id": room_oid}, {"$set": {"joinCode": generate_join_code()}}
            )
            stats["backfilledJoinCodes"] += 1

        # 2. The host must still be a real account; otherwise the room can never
        #    be deleted/kicked/transferred again (host can't log in) -> drop it.
        host_id = room.get("hostId")
        host_ok = bool(host_id) and ObjectId.is_valid(str(host_id))
        if host_ok:
            host_doc = await users.find_one({"_id": ObjectId(str(host_id))}, {"_id": 1})
            host_ok = host_doc is not None
        if not host_ok:
            await rooms.delete_one({"_id": room_oid})
            deleted_room_ids.add(room_id_str)
            stats["deletedHostless"] += 1
            continue

        # 3. Prune member/controller ids that point at deleted accounts.
        raw_members = list(dict.fromkeys(
            str(m) for m in (room.get("members") or []) if m not in (None, "")
        ))
        raw_controllers = list(dict.fromkeys(
            str(c) for c in (room.get("controllers") or []) if c not in (None, "")
        ))

        object_ids = [ObjectId(m) for m in raw_members if ObjectId.is_valid(m)]
        found: set[str] = set()
        if object_ids:
            cursor = users.find({"_id": {"$in": object_ids}}, {"_id": 1})
            found = {str(u["_id"]) for u in await cursor.to_list(length=len(object_ids))}

        members = [m for m in raw_members if m in found]
        controllers = [c for c in raw_controllers if c in found or c == str(host_id)]

        # Host is always a member + controller by construction.
        host_s = str(host_id)
        changed = False
        if host_s not in members:
            members.insert(0, host_s)
            changed = True
        if host_s not in controllers:
            controllers.insert(0, host_s)
            changed = True

        if len(members) != len(raw_members):
            changed = True
        if len(controllers) != len(raw_controllers):
            changed = True

        # 4. A room with nobody left is unreachable -> delete instead of keeping
        #    a zombie row.
        if not members and not controllers:
            await rooms.delete_one({"_id": room_oid})
            deleted_room_ids.add(room_id_str)
            stats["deletedEmpty"] += 1
            continue

        if changed:
            await rooms.update_one(
                {"_id": room_oid},
                {"$set": {"members": members, "controllers": controllers}},
            )
            stats["prunedMembers"] += len(raw_members) - len(members)
            stats["prunedControllers"] += len(raw_controllers) - len(controllers)

        live_room_ids.add(room_id_str)

    # 5. Drop room_invite notifications whose target room no longer exists.
    #    Always scan: rooms can be deleted at runtime (hostless-connection
    #    cleanup + explicit DELETE), so stale invites accumulate over time.
    stale = await notifications.delete_many({
        "type": "room_invite",
        "roomId": {"$nin": list(live_room_ids)},
    })
    stats["removedStaleInvites"] += stale.deleted_count

    return stats