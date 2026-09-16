"""
Regression tests for Strumm Rooms.

Covers the production-readiness fixes:
  - GET /social/rooms: visibility filter (no circle-room leak) + no N+1 crash
    on malformed hostIds.
  - GET /social/rooms/{roomId}: access rule + controllers + hostName.
  - GET /social/rooms/search + /social/rooms/suggestions.
  - POST /social/rooms: controllers seed + room:created push.
  - DELETE /social/rooms: host-only + room:deleted push.
  - can_control: host + approved-controller gating for playback events.
  - handle_room_disconnect: room:left broadcast, DEFERRED host transfer (a
    transient host socket drop never strips the host's controls; ownership is
    handed to the longest-connected member only after a grace window, and a
    reconnect cancels it), and deferred (grace-window) deletion of a hostless
    empty room that stays empty — not an instant delete on socket drop.

MongoDB and the realtime manager are mocked; no external services are touched.
"""

from __future__ import annotations

import asyncio

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from bson import ObjectId


@pytest.fixture
def mock_db():
    """Mock the MongoDB database with a distinct child per collection.

    MagicMock.__getitem__ returns the SAME shared child for every key, which
    would clobber per-collection mocks (e.g. ``mock_db["users"].find_one``
    overwriting ``mock_db["rooms"].find_one``). So we cache a dedicated mock
    per collection name.
    """
    from app.database import mongodb
    db = MagicMock()
    db.ROOMS = "rooms"
    db.USERS = "users"
    db.CONNECTIONS = "connections"
    db.ACTIVITIES = "activities"
    db.NOTIFICATIONS = "notifications"

    children: dict = {}

    def _cursor(docs=None):
        cursor = AsyncMock()
        cursor.to_list = AsyncMock(return_value=docs or [])
        cursor.sort = MagicMock(return_value=cursor)
        cursor.limit = MagicMock(return_value=cursor)
        return cursor

    def _child(key: str):
        if key not in children:
            c = MagicMock()
            c.insert_one = AsyncMock()
            c.update_one = AsyncMock()
            c.update_many = AsyncMock()
            c.delete_one = AsyncMock()
            c.find_one = AsyncMock(return_value=None)
            c.find = MagicMock(return_value=_cursor())
            children[key] = c
        return children[key]

    db.__getitem__.side_effect = _child
    db._cursor = _cursor

    # Any code path calling app.database.mongodb.get_db() gets this mock.
    mongodb.get_db = MagicMock(return_value=db)
    return db


def _set_find(db, collection_key, docs):
    """Make ``db[collection].find()`` return a chainable cursor of ``docs``."""
    cursor = AsyncMock()
    cursor.to_list = AsyncMock(return_value=docs)
    cursor.sort = MagicMock(return_value=cursor)
    cursor.limit = MagicMock(return_value=cursor)
    db[collection_key].find = MagicMock(return_value=cursor)
    return cursor


@pytest.fixture
def mock_realtime():
    """Patch the room manager wherever the new rooms modules reach it.

    services.rooms uses ``manager = realtime_manager`` and routes/rooms.py
    binds its own ``ws_manager`` alias at import time, so both module-level
    names must point at the SAME mock for cross-module assertions (e.g. the
    invite route pushes via ``ws_manager.send_to_user`` while disconnect
    cleanup broadcasts via ``services.rooms.manager``).
    """
    manager = MagicMock()
    manager.broadcast_to_circle = AsyncMock()
    manager.send_to_user = AsyncMock()
    manager.broadcast_to_room = AsyncMock()
    manager.send_json = AsyncMock()
    manager.connect_room = AsyncMock()
    manager.disconnect_room = MagicMock(return_value=None)
    manager.disconnect_user_from_room = MagicMock(return_value=None)
    manager.room_connected_user_ids = MagicMock(return_value=[])
    with patch("app.services.rooms.manager", manager), \
         patch("app.routes.rooms.ws_manager", manager):
        yield manager


@pytest.fixture
def client(mock_db, mock_realtime):
    """Create an httpx AsyncClient pointed at the FastAPI app."""
    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return {
            "id": "user_host",
            "username": "hosty",
            "displayName": "Hosty",
            "email": "host@example.com",
            "createdAt": "2025-01-01T00:00:00",
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


# ---------------------------------------------------------------------------
# GET /social/rooms — visibility filter + N+1 host name resolution
# ---------------------------------------------------------------------------


async def test_list_rooms_hides_circle_rooms_from_non_members(client, mock_db):
    public_room = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c2"),
        "name": "Public Lounge",
        "hostId": "user_other",
        "members": ["user_other"],
        "visibility": "public",
        "queue": [],
        "controllers": ["user_other"],
    }
    circle_room = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c3"),
        "name": "Secret Circle Room",
        "hostId": "user_other",
        "members": ["user_other", "user_circle_friend"],
        "visibility": "circle",
        "queue": [],
        "controllers": ["user_other"],
    }
    _set_find(mock_db, mock_db.ROOMS, [public_room, circle_room])

    host_doc = {"_id": ObjectId("6630a1c2e4b0a1c2e4b0a111"), "displayName": "Someone Else"}
    cursor = AsyncMock()
    cursor.to_list = AsyncMock(return_value=[host_doc])
    mock_db[mock_db.USERS].find = MagicMock(return_value=cursor)
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=host_doc)

    res = await client.get("/social/rooms")
    assert res.status_code == 200

    # The filter passed to Mongo must never surface circle rooms to non-members.
    find_query = mock_db[mock_db.ROOMS].find.call_args.args[0]
    assert find_query == {
        "$or": [
            {"visibility": "public"},
            {"hostId": "user_host"},
            {"members": "user_host"},
        ]
    }

    # For the rows Mongo DOES return under that filter, host names resolve.
    data = res.json()["data"]
    assert data[0]["name"] == "Public Lounge"
    assert data[0]["hostName"] == "Someone Else"


async def test_list_rooms_includes_own_circle_room(client, mock_db):
    own_circle_room = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c4"),
        "name": "My Circle Room",
        "hostId": "user_host",  # current user is host -> visible
        "members": ["user_host"],
        "visibility": "circle",
        "queue": [],
        "controllers": ["user_host"],
    }
    _set_find(mock_db, mock_db.ROOMS, [own_circle_room])
    cursor = AsyncMock()
    cursor.to_list = AsyncMock(return_value=[])
    mock_db[mock_db.USERS].find = MagicMock(return_value=cursor)

    res = await client.get("/social/rooms")
    assert res.status_code == 200
    assert res.json()["data"][0]["name"] == "My Circle Room"


async def test_list_rooms_survives_malformed_host_id(client, mock_db, mock_realtime):
    """A stale/corrupt hostId must not 400 the whole room list."""
    dodgy_room = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c5"),
        "name": "Legacy Room",
        "hostId": "not-a-valid-objectid-at-all",
        "members": ["user_host"],
        "visibility": "public",
        "queue": [],
        "controllers": ["user_host"],
    }
    _set_find(mock_db, mock_db.ROOMS, [dodgy_room])
    # ObjectId-valid batch returns nothing; find_one for the string id returns None.
    cursor = AsyncMock()
    cursor.to_list = AsyncMock(return_value=[])
    mock_db[mock_db.USERS].find = MagicMock(return_value=cursor)
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)

    res = await client.get("/social/rooms")
    assert res.status_code == 200
    assert res.json()["data"][0]["hostName"] == "Unknown"


# ---------------------------------------------------------------------------
# POST /social/rooms — controllers seed + room:created push
# ---------------------------------------------------------------------------


async def test_create_room_seeds_controllers_and_notifies(client, mock_db, mock_realtime):
    inserted_id = ObjectId("6630a1c2e4b0a1c2e4b0a1c6")

    def fake_insert(doc):
        doc["_id"] = inserted_id
        return MagicMock(inserted_id=inserted_id)

    mock_db[mock_db.ROOMS].insert_one = AsyncMock(side_effect=fake_insert)
    # Give the host one circle friend so room:created is pushed to the circle.
    conn_cursor = AsyncMock()
    conn_cursor.to_list = AsyncMock(return_value=[
        {"requesterId": "user_host", "receiverId": "friend_one", "status": "accepted"},
    ])
    mock_db[mock_db.CONNECTIONS].find = MagicMock(return_value=conn_cursor)

    res = await client.post("/social/rooms", json={"name": "Late Night", "visibility": "public"})
    assert res.status_code == 200
    body = res.json()["data"]
    assert body["id"] == str(inserted_id)
    assert body["hostName"] == "Hosty"
    assert body["controllers"] == ["user_host"]

    assert mock_realtime.broadcast_to_circle.await_count >= 1
    created_call = mock_realtime.broadcast_to_circle.call_args_list[0]
    assert created_call.args[1]["event"] == "room:created"


# ---------------------------------------------------------------------------
# GET /social/rooms/{roomId} — access gate + controllers + hostName
# ---------------------------------------------------------------------------


async def test_get_room_denies_circle_room_to_stranger(client, mock_db):
    room = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c7"),
        "name": "Circle Room",
        "hostId": "user_other",
        "members": ["user_other"],
        "visibility": "circle",
        "queue": [],
        "controllers": ["user_other"],
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    # Not a circle member of user_other
    mock_db[mock_db.CONNECTIONS].find_one = AsyncMock(return_value=None)

    res = await client.get(f"/social/rooms/{room['_id']}")
    assert res.status_code == 403


async def test_get_room_404_on_invalid_id(client, mock_db):
    res = await client.get("/social/rooms/not-an-objectid!!!")
    assert res.status_code == 404


async def test_get_room_returns_host_name_and_controllers(client, mock_db):
    member_id = ObjectId("6630a1c2e4b0a1c2e4b0a1c9")
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a1c8")
    room = {
        "_id": room_id,
        "name": "Public Room",
        "hostId": "user_host",
        "members": [str(member_id)],
        "visibility": "public",
        "queue": [],
        "controllers": ["user_host", str(member_id)],
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)

    members_cursor = AsyncMock()
    members_cursor.to_list = AsyncMock(return_value=[
        {"_id": member_id, "displayName": "Controller"},
    ])
    mock_db[mock_db.USERS].find = MagicMock(return_value=members_cursor)
    host_doc = {"_id": "user_host", "displayName": "Hosty"}
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=host_doc)

    res = await client.get(f"/social/rooms/{room_id}")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["hostName"] == "Hosty"
    assert data["controllers"] == ["user_host", str(member_id)]
    assert any(p["displayName"] == "Controller" for p in data["membersProfiles"])


# ---------------------------------------------------------------------------
# GET /social/rooms/search + /social/rooms/suggestions
# ---------------------------------------------------------------------------


async def test_search_rooms_empty_query_returns_empty_quickly(client, mock_db):
    res = await client.get("/social/rooms/search")
    assert res.status_code == 200
    assert res.json()["data"] == []


async def test_suggest_rooms_excludes_own_rooms(client, mock_db):
    suggestion = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1aa"),
        "name": "Fresh Room",
        "hostId": "user_other",
        "members": ["user_other"],
        "visibility": "public",
        "queue": [],
        "controllers": ["user_other"],
    }
    _set_find(mock_db, mock_db.ROOMS, [suggestion])
    cursor = AsyncMock()
    cursor.to_list = AsyncMock(return_value=[])
    mock_db[mock_db.USERS].find = MagicMock(return_value=cursor)

    res = await client.get("/social/rooms/suggestions")
    assert res.status_code == 200
    assert [r["name"] for r in res.json()["data"]] == ["Fresh Room"]


# ---------------------------------------------------------------------------
# DELETE /social/rooms/{roomId} — host only + room:deleted push
# ---------------------------------------------------------------------------


async def test_delete_room_forbids_non_host(client, mock_db):
    room = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1bb"),
        "name": "Hosted Elsewhere",
        "hostId": "user_other",
        "members": ["user_other"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    res = await client.delete(f"/social/rooms/{room['_id']}")
    assert res.status_code == 403


async def test_delete_room_notifies_and_removes(client, mock_db, mock_realtime):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a1cc")
    room = {
        "_id": room_id,
        "name": "My Room",
        "hostId": "user_host",
        "members": ["user_host", "user_other"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()

    res = await client.delete(f"/social/rooms/{room_id}")
    assert res.status_code == 200
    mock_db[mock_db.ROOMS].delete_one.assert_awaited()
    # pushed on the room channel (and to the host's own global connections)
    assert mock_realtime.broadcast_to_room.await_count >= 1
    assert mock_realtime.send_to_user.await_count >= 1


# ---------------------------------------------------------------------------
# can_control — host + approved controller gating
# ---------------------------------------------------------------------------


async def test_can_control_gates_by_host_then_controllers(mock_db):
    from app.services.rooms import can_control as _can_control

    room_id = "6630a1c2e4b0a1c2e4b0a1dd"
    room = {
        "_id": ObjectId(room_id),
        "hostId": "host",
        "controllers": ["host", "dj"],
        "members": ["host", "dj", "listener"],
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)

    assert (await _can_control(mock_db, room_id, "host"))["allowed"] is True
    assert (await _can_control(mock_db, room_id, "dj"))["allowed"] is True
    denied = await _can_control(mock_db, room_id, "listener")
    assert denied["allowed"] is False
    assert "host" in denied["reason"] or "controller" in denied["reason"]


async def test_can_control_missing_room_denied(mock_db):
    from app.services.rooms import can_control as _can_control

    room_id = "6630a1c2e4b0a1c2e4b0a1ee"
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=None)
    denied = await _can_control(mock_db, room_id, "host")
    assert denied["allowed"] is False


# ---------------------------------------------------------------------------
# ROOM WS EVENT CONTRACT — keeps backend broadcasts aligned with the
# event names the web client subscribes to (regression: the client previously
# listened for "room:leave" while the server sends "room:left", so members
# never disappeared from the roster).
# ---------------------------------------------------------------------------


async def test_room_ws_event_names_are_contract_stable(mock_db, mock_realtime):
    from app.services.realtime.events import (
        ROOM_JOINED,
        ROOM_LEFT,
        ROOM_HOST_TRANSFERRED,
        ROOM_CONTROLLERS_UPDATED,
    )

    # The canonical event names the web client MUST subscribe to. If these
    # change, the client's WS handlers (apps/web/src/app/rooms/[id]/page.tsx)
    # must be updated in the same change.
    assert ROOM_JOINED == "room:joined"
    assert ROOM_LEFT == "room:left"
    assert ROOM_HOST_TRANSFERRED == "room:host_transferred"
    assert ROOM_CONTROLLERS_UPDATED == "room:controllers_updated"


async def test_disconnect_broadcasts_canonical_room_left_constant(mock_db, mock_realtime):
    """The leave broadcast must use the ROOM_LEFT ('room:left') constant, NOT
    the legacy 'room:leave' string — the whole point of the room-fix."""
    from app.services.rooms import handle_room_disconnect as _handle_room_disconnect
    from app.services.realtime.events import ROOM_LEFT

    room_id = "6630a1c2e4b0a1c2e4b0a91f"
    room = {
        "_id": ObjectId(room_id),
        "name": "Room",
        "hostId": "host",
        "members": ["host", "listener"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)
    mock_realtime.room_connected_user_ids.return_value = ["host"]

    await _handle_room_disconnect(room_id, "listener")

    leave_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == ROOM_LEFT
    ]
    assert leave_calls, "expected a room:left broadcast on disconnect"


# ---------------------------------------------------------------------------
# handle_room_disconnect — room:left + host auto-transfer + empty-room delete
# ---------------------------------------------------------------------------


async def test_disconnect_broadcasts_leave(mock_db, mock_realtime):
    from app.services.rooms import handle_room_disconnect as _handle_room_disconnect

    room_id = "6630a1c2e4b0a1c2e4b0a1ff"
    room = {
        "_id": ObjectId(room_id),
        "name": "Room",
        "hostId": "host",
        "members": ["host", "listener"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)

    # listener leaves; host stays -> no transfer
    await _handle_room_disconnect(room_id, "listener")

    mock_realtime.broadcast_to_room.assert_awaited()
    leave_call = mock_realtime.broadcast_to_room.call_args
    assert leave_call.kwargs["message"]["event"] == "room:left"
    assert leave_call.kwargs["message"]["data"]["userId"] == "listener"
    mock_db[mock_db.ROOMS].update_one.assert_awaited()
    mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()


async def test_disconnect_auto_transfers_host_after_grace(mock_db, mock_realtime):
    """A host socket drop while listeners are connected does NOT transfer
    ownership instantly — the hand-off is deferred by ROOM_HOST_TRANSFER_GRACE
    so a transient blip can't strip the host's controls. After the grace (here
    shortened to ~0) with the host still gone, the room transfers to the first
    remaining connected member."""
    from app.services.rooms import handle_room_disconnect as _handle_room_disconnect

    room_id = "6630a1c2e4b0a1c2e4b0a111"
    room = {
        "_id": ObjectId(room_id),
        "name": "Room",
        "hostId": "host",
        "members": ["host", "veteran", "newbie"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    host_doc = {"_id": ObjectId("6630a1c2e4b0a1c2e4b0a222"), "displayName": "Veteran"}
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=host_doc)
    conn_cursor = AsyncMock()
    conn_cursor.to_list = AsyncMock(return_value=[])
    mock_db[mock_db.CONNECTIONS].find = MagicMock(return_value=conn_cursor)

    # Room manager still holds veteran connected, in join order.
    mock_realtime.room_connected_user_ids.return_value = ["veteran", "newbie"]

    # Transfer is deferred: the moment the host disconnects, ownership is
    # untouched (no hostId update, no host_transferred broadcast, no
    # room:left, no member removal).
    with patch("app.services.rooms.ROOM_HOST_TRANSFER_GRACE", 60.0):
        await _handle_room_disconnect(room_id, "host")
        await asyncio.sleep(0.05)

    transfer_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:host_transferred"
    ]
    assert not transfer_calls
    host_transfer_updates = [
        call for call in mock_db[mock_db.ROOMS].update_one.call_args_list
        if isinstance(call.args[1], dict) and call.args[1].get("$set", {}).get("hostId")
    ]
    assert not host_transfer_updates
    mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()

    # Cancel the still-pending long-grace task, then let a fresh grace elapse
    # with the host still gone -> transfer commits to the first remaining
    # connected member.
    from app.services.rooms import cancel_pending_host_transfer
    cancel_pending_host_transfer(room_id)
    with patch("app.services.rooms.ROOM_HOST_TRANSFER_GRACE", 0.0):
        await _handle_room_disconnect(room_id, "host")
        await asyncio.sleep(0.05)

    transfer_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:host_transferred"
    ]
    assert transfer_calls
    assert transfer_calls[0].kwargs["message"]["data"]["hostId"] == "veteran"
    host_transfer_updates = [
        call for call in mock_db[mock_db.ROOMS].update_one.call_args_list
        if isinstance(call.args[1], dict) and call.args[1].get("$set", {}).get("hostId")
    ]
    assert host_transfer_updates
    assert host_transfer_updates[0].args[1]["$set"]["hostId"] == "veteran"

    mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()


async def test_disconnect_host_reconnect_cancels_transfer(mock_db, mock_realtime):
    """If the host's socket comes back inside the grace window, the deferred
    host hand-off is cancelled and the host keeps control."""
    from app.services.rooms import (
        cancel_pending_host_transfer,
        handle_room_disconnect as _handle_room_disconnect,
    )

    room_id = "6630a1c2e4b0a1c2e4b0a112"
    room = {
        "_id": ObjectId(room_id),
        "name": "Room",
        "hostId": "host",
        "members": ["host", "veteran"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    host_doc = {"_id": ObjectId("6630a1c2e4b0a1c2e4b0a222"), "displayName": "Veteran"}
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=host_doc)
    conn_cursor = AsyncMock()
    conn_cursor.to_list = AsyncMock(return_value=[])
    mock_db[mock_db.CONNECTIONS].find = MagicMock(return_value=conn_cursor)
    mock_realtime.room_connected_user_ids.return_value = ["veteran"]

    with patch("app.services.rooms.ROOM_HOST_TRANSFER_GRACE", 60.0):
        # Host socket drops while a listener is connected -> transfer scheduled.
        await _handle_room_disconnect(room_id, "host")

        # The room WS accept path calls this when the host reconnects.
        cancel_pending_host_transfer(room_id)
        await asyncio.sleep(0.05)

    # No hostId update, no host_transferred broadcast — host kept the room.
    host_transfer_updates = [
        call for call in mock_db[mock_db.ROOMS].update_one.call_args_list
        if isinstance(call.args[1], dict) and call.args[1].get("$set", {}).get("hostId")
    ]
    assert not host_transfer_updates
    transfer_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:host_transferred"
    ]
    assert not transfer_calls
    mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()


async def test_disconnect_empties_and_deletes_room(mock_db, mock_realtime):
    from app.services.rooms import handle_room_disconnect as _handle_room_disconnect

    room_id = "6630a1c2e4b0a1c2e4b0a333"
    room = {
        "_id": ObjectId(room_id),
        "name": "Solo Room",
        "hostId": "host",
        "members": ["host"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)
    # no other connected members
    mock_realtime.room_connected_user_ids.return_value = []
    # one circle friend so the room:deleted circle push fires
    conn_cursor = AsyncMock()
    conn_cursor.to_list = AsyncMock(return_value=[
        {"requesterId": "host", "receiverId": "circle_friend", "status": "accepted"},
    ])
    mock_db[mock_db.CONNECTIONS].find = MagicMock(return_value=conn_cursor)

    # Instant-disconnect deletes are gone: an emptied hostless room is removed
    # only after the (here shortened to ~0) grace window stays empty.
    with patch("app.services.rooms.ROOM_HOSTLESS_DELETE_GRACE", 0.0):
        await _handle_room_disconnect(room_id, "host")
        await asyncio.sleep(0.05)

    mock_db[mock_db.ROOMS].delete_one.assert_awaited()
    # room:deleted pushed (room + circle channels)
    deleted_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:deleted"
    ]
    assert deleted_calls
    assert mock_realtime.broadcast_to_circle.await_count >= 1


async def test_disconnect_survives_reconnect_within_grace(mock_db, mock_realtime):
    """A transient host socket drop must NOT destroy the room before anyone
    (including the host) has a chance to reconnect: the deferred delete exists,
    so a reconnect within the grace window keeps the room alive."""
    from app.services.rooms import (
        cancel_pending_room_delete,
        handle_room_disconnect as _handle_room_disconnect,
    )

    room_id = "6630a1c2e4b0a1c2e4b0a334"
    room = {
        "_id": ObjectId(room_id),
        "name": "Solo Room",
        "hostId": "host",
        "members": ["host"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)
    mock_realtime.room_connected_user_ids.return_value = []

    # Grace is far in the future so the socket drop cannot delete anything.
    with patch("app.services.rooms.ROOM_HOSTLESS_DELETE_GRACE", 900.0):
        await _handle_room_disconnect(room_id, "host")
        mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()

        # The room WS accept path calls this on every (re)connect.
        cancel_pending_room_delete(room_id)
        await asyncio.sleep(0.05)

    # Room survived — reconnect cancelled the deferred delete for good.
    mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()
    room_deleted = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:deleted"
    ]
    assert not room_deleted


# ---------------------------------------------------------------------------
# POST /social/rooms/{roomId}/invite — host invites a Circle friend
# ---------------------------------------------------------------------------


async def test_invite_friend_adds_to_room_and_notifies(client, mock_db, mock_realtime):
    room_id = "6630a1c2e4b0a1c2e4b0a444"
    friend_id = "6630a1c2e4b0a1c2e4b0a555"
    room = {
        "_id": ObjectId(room_id),
        "name": "My Room",
        "hostId": "user_host",
        "members": ["user_host"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.NOTIFICATIONS].insert_one = AsyncMock()
    # Friend is in the host's accepted circle
    mock_db[mock_db.CONNECTIONS].find_one = AsyncMock(return_value={
        "requesterId": "user_host",
        "receiverId": friend_id,
        "status": "accepted",
    })

    res = await client.post(f"/social/rooms/{room_id}/invite", json={"userId": friend_id})
    assert res.status_code == 200
    assert res.json()["success"] is True

    # The invitee is granted access to the room doc.
    update_call = mock_db[mock_db.ROOMS].update_one.call_args
    assert update_call.args[0] == {"_id": ObjectId(room_id)}
    assert update_call.args[1] == {"$addToSet": {"invited": friend_id}}

    # A room_invite notification is persisted for the invitee.
    notif = mock_db[mock_db.NOTIFICATIONS].insert_one.call_args.args[0]
    assert notif["userId"] == friend_id
    assert notif["type"] == "room_invite"
    assert notif["roomId"] == room_id
    assert notif["roomName"] == "My Room"

    # Realtime room:invited event pushed straight to the invitee.
    mock_realtime.send_to_user.assert_awaited_once()
    sent = mock_realtime.send_to_user.call_args
    assert sent.args[0] == friend_id
    assert sent.args[1]["event"] == "room:invited"
    assert sent.args[1]["data"]["roomId"] == room_id


async def test_invite_forbids_non_host(client, mock_db):
    room_id = "6630a1c2e4b0a1c2e4b0a666"
    room = {
        "_id": ObjectId(room_id),
        "name": "Their Room",
        "hostId": "someone_else",
        "members": ["someone_else"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)

    res = await client.post(
        f"/social/rooms/{room_id}/invite",
        json={"userId": "6630a1c2e4b0a1c2e4b0a777"},
    )
    assert res.status_code == 403


async def test_invite_rejects_non_friend(client, mock_db):
    room_id = "6630a1c2e4b0a1c2e4b0a888"
    stranger_id = "6630a1c2e4b0a1c2e4b0a999"
    room = {
        "_id": ObjectId(room_id),
        "name": "My Room",
        "hostId": "user_host",
        "members": ["user_host"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.CONNECTIONS].find_one = AsyncMock(return_value=None)  # not a circle member

    res = await client.post(
        f"/social/rooms/{room_id}/invite",
        json={"userId": stranger_id},
    )
    assert res.status_code == 403
    mock_db[mock_db.NOTIFICATIONS].insert_one.assert_not_awaited()


# ---------------------------------------------------------------------------
# Join codes — POST /social/rooms/{roomId}/join-code + GET /by-code/{code}
# ---------------------------------------------------------------------------


async def test_join_code_regen_is_host_only(client, mock_db):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a0aa")
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value={
        "_id": room_id,
        "name": "Their Room",
        "hostId": "user_other",
        "members": ["user_other"],
        "visibility": "circle",
    })
    res = await client.post(f"/social/rooms/{room_id}/join-code")
    assert res.status_code == 403


async def test_join_code_regen_returns_new_code(client, mock_db):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a0bb")
    room = {
        "_id": room_id,
        "name": "My Room",
        "hostId": "user_host",
        "members": ["user_host"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()

    res = await client.post(f"/social/rooms/{room_id}/join-code")
    assert res.status_code == 200
    code = res.json()["data"]["joinCode"]
    assert len(code) == 6 and code.isalnum()

    update_call = mock_db[mock_db.ROOMS].update_one.call_args
    assert update_call.args[0] == {"_id": room_id}
    assert update_call.args[1] == {"$set": {"joinCode": code}}


async def test_join_code_generated_with_ambiguous_chars_excluded(mock_db):
    """Join codes must never contain 0/O/1/I/l so spoken/printed codes work."""
    from app.services.rooms import generate_join_code
    safe = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(200):
        code = generate_join_code()
        assert all(c in safe for c in code)
        assert len(code) == 6


async def test_find_room_by_join_code_normalizes_case_and_spaces(mock_db):
    from app.services.rooms import find_room_by_join_code

    room = {"_id": ObjectId("6630a1c2e4b0a1c2e4b0a0cc"), "name": "X"}
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)

    result = await find_room_by_join_code(mock_db, "  ab12 cd3  ")
    assert result is not None
    find_call = mock_db[mock_db.ROOMS].find_one.call_args
    assert find_call.args[0]["joinCode"] == "AB12CD3"


async def test_by_code_resolves_public_room(client, mock_db):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a0dd")
    room = {
        "_id": room_id,
        "name": "Secret Sesh",
        "hostId": "user_other",
        "members": ["user_other", "user_host"],
        "visibility": "public",
        "joinCode": "K7JX2M",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value={
        "_id": object(),
        "displayName": "Someone Else",
    })

    res = await client.get("/social/rooms/by-code/K7JX2M")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["id"] == str(room_id)
    assert data["memberCount"] == 2


async def test_by_code_404_unknown_code(client, mock_db):
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=None)
    res = await client.get("/social/rooms/by-code/ZZZZZZ")
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Kick — host kicks a listener out of the room
# ---------------------------------------------------------------------------


async def test_kick_requires_host(client, mock_db):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a0ee")
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value={
        "_id": room_id,
        "name": "Their Room",
        "hostId": "user_other",
        "members": ["user_other", "user_host"],
        "visibility": "public",
    })
    res = await client.post(
        f"/social/rooms/{room_id}/kick",
        json={"userId": "user_host"},
    )
    assert res.status_code == 403


async def test_kick_removes_listener_and_broadcasts(client, mock_db, mock_realtime):
    from app.services.realtime.events import ROOM_KICKED

    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a0ff")
    room = {
        "_id": room_id,
        "name": "My Room",
        "hostId": "user_host",
        "members": ["user_host", "listener_one"],
        "controllers": ["user_host"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)

    res = await client.post(
        f"/social/rooms/{room_id}/kick",
        json={"userId": "listener_one"},
    )
    assert res.status_code == 200

    kick_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == ROOM_KICKED
    ]
    assert kick_calls, "expected a room:kicked broadcast"
    assert kick_calls[0].kwargs["message"]["data"]["userId"] == "listener_one"
    # Kicked user's live sockets are dropped from the room channel
    assert mock_realtime.disconnect_user_from_room.called


# ---------------------------------------------------------------------------
# Leave — clean REST leave so a dead socket can't strand a member in a room
# ---------------------------------------------------------------------------


async def test_leave_disconnects_sockets_and_cleans_up(client, mock_db, mock_realtime):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a111")
    room = {
        "_id": room_id,
        "name": "My Room",
        "hostId": "user_host",
        "members": ["user_host", "listener_one"],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=room)
    mock_db[mock_db.ROOMS].update_one = AsyncMock()
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)
    mock_realtime.room_connected_user_ids.return_value = []

    # No members left -> the room is removed once the grace window elapses.
    with patch("app.services.rooms.ROOM_HOSTLESS_DELETE_GRACE", 0.0):
        res = await client.post(f"/social/rooms/{room_id}/leave")
        assert res.status_code == 200
        await asyncio.sleep(0.05)

    mock_realtime.disconnect_user_from_room.assert_called_with(str(room_id), "user_host")
    leave_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:left"
    ]
    assert leave_calls
    assert mock_db[mock_db.ROOMS].delete_one.await_count >= 1  # room gone


async def test_leave_requires_membership(client, mock_db):
    room_id = ObjectId("6630a1c2e4b0a1c2e4b0a122")
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value={
        "_id": room_id,
        "name": "Their Room",
        "hostId": "user_other",
        "members": ["user_other"],
        "visibility": "public",
    })
    res = await client.post(f"/social/rooms/{room_id}/leave")
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# queue:remove + queue:clear — host/controller-gated queue mutations
# ---------------------------------------------------------------------------


async def test_queue_clear_clears_via_dollar_set(mock_db):
    from app.services.rooms import queue_clear

    room_oid = ObjectId("6630a1c2e4b0a1c2e4b0a133")
    mock_db[mock_db.ROOMS].update_one = AsyncMock()

    await queue_clear(mock_db, room_oid)
    call = mock_db[mock_db.ROOMS].update_one.call_args
    assert call.args[0] == {"_id": room_oid}
    assert call.args[1] == {"$set": {"queue": []}}


async def test_queue_remove_matches_video_id(mock_db):
    from app.services.rooms import queue_remove

    room_oid = ObjectId("6630a1c2e4b0a1c2e4b0a144")
    mock_update = AsyncMock(modified_count=0)
    mock_update.return_value.modified_count = 0
    mock_db[mock_db.ROOMS].update_one = mock_update

    removed = await queue_remove(mock_db, room_oid, "abc_123")
    call = mock_update.call_args
    assert call.args[0] == {"_id": room_oid}
    assert call.args[1] == {"$pull": {"queue": {"videoId": "abc_123"}}}
    assert removed == 0


# ---------------------------------------------------------------------------
# cleanup_legacy_rooms — idempotent one-shot normalization of old room docs
# ---------------------------------------------------------------------------


async def _legacy_cursor(docs):
    """Wrap a doc list in an async-iterable cursor for `async for` loops."""
    class _Cursor:
        def __init__(self, docs):
            self._docs = docs

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._docs:
                raise StopAsyncIteration
            return self._docs.pop(0)

    return _Cursor(list(docs))


def _user_cursor(doc_ids):
    """Cursor whose to_list() resolves to user docs with the given _ids."""
    import asyncio
    cursor = MagicMock()
    async def _to_list(length=0):
        return [{"_id": i, "displayName": "U"} for i in doc_ids]
    cursor.to_list = _to_list
    return cursor


async def test_cleanup_backfills_join_codes_and_dedupes(mock_db):
    from app.services.rooms import cleanup_legacy_rooms

    host_id = "6630a1c2e4b0a1c2e4b0a155"
    room = {
        "_id": ObjectId(host_id),
        "name": "Legacy",
        "hostId": host_id,
        "members": [host_id, host_id, "deleted_member"],
        "controllers": [host_id, "deleted_member"],
        "visibility": "circle",
    }
    mock_db[mock_db.ROOMS].find = MagicMock(return_value=await _legacy_cursor([room]))
    # Host exists (via find_one, which cleanup uses for the host check);
    # the deleted_member id resolves to no user (via the batched find).
    mock_db[mock_db.USERS].find_one = AsyncMock(
        return_value={"_id": ObjectId(host_id), "displayName": "Hosty"},
    )
    mock_db[mock_db.USERS].find = MagicMock(
        return_value=_user_cursor([ObjectId(host_id)]),
    )
    mock_delete = AsyncMock()
    mock_delete.return_value.deleted_count = 0
    mock_db[mock_db.NOTIFICATIONS].delete_many = mock_delete

    stats = await cleanup_legacy_rooms(mock_db)
    assert stats["backfilledJoinCodes"] == 1
    set_call = mock_db[mock_db.ROOMS].update_one.call_args.args[1]["$set"]
    assert set_call["members"] == [host_id]
    assert set_call["controllers"] == [host_id]
    assert stats["prunedMembers"] == 1
    assert stats["prunedControllers"] == 1
    mock_db[mock_db.NOTIFICATIONS].delete_many.assert_awaited()


async def test_cleanup_drops_hostless_rooms(mock_db):
    from app.services.rooms import cleanup_legacy_rooms

    gone_host = "6630a1c2e4b0a1c2e4b0a177"
    orphan = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a166"),
        "name": "Orphan",
        "hostId": gone_host,
        "members": [gone_host],
        "visibility": "public",
    }
    mock_db[mock_db.ROOMS].find = MagicMock(return_value=await _legacy_cursor([orphan]))
    mock_db[mock_db.ROOMS].delete_one = AsyncMock()
    mock_db[mock_db.USERS].find_one = AsyncMock(return_value=None)  # host account gone
    mock_delete = AsyncMock()
    mock_delete.return_value.deleted_count = 0
    mock_db[mock_db.NOTIFICATIONS].delete_many = mock_delete

    stats = await cleanup_legacy_rooms(mock_db)
    assert stats["deletedHostless"] == 1
    assert stats["deletedEmpty"] == 0
    mock_db[mock_db.ROOMS].delete_one.assert_awaited()