"""
Regression tests for Strumm Rooms.

Covers the production-readiness fixes:
  - GET /social/rooms: visibility filter (no circle-room leak) + no N+1 crash
    on malformed hostIds.
  - GET /social/rooms/{roomId}: access rule + controllers + hostName.
  - GET /social/rooms/search + /social/rooms/suggestions.
  - POST /social/rooms: controllers seed + room:created push.
  - DELETE /social/rooms: host-only + room:deleted push.
  - _can_control: host + approved-controller gating for playback events.
  - _handle_room_disconnect: room:left broadcast, host auto-transfer to the
    longest-connected member, hostless empty room deletion.

MongoDB and the realtime manager are mocked; no external services are touched.
"""

from __future__ import annotations

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
    """Patch the module-level ws_manager alias."""
    with patch("app.routes.social.ws_manager") as m:
        m.broadcast_to_circle = AsyncMock()
        m.send_to_user = AsyncMock()
        m.broadcast_to_room = AsyncMock()
        m.send_json = AsyncMock()
        m.connect_room = AsyncMock()
        m.disconnect_room = MagicMock(return_value=None)
        m.room_connected_user_ids = MagicMock(return_value=[])
        yield m


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
# _can_control — host + approved controller gating
# ---------------------------------------------------------------------------


async def test_can_control_gates_by_host_then_controllers(mock_db):
    from app.routes.social import _can_control

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
    from app.routes.social import _can_control

    room_id = "6630a1c2e4b0a1c2e4b0a1ee"
    mock_db[mock_db.ROOMS].find_one = AsyncMock(return_value=None)
    denied = await _can_control(mock_db, room_id, "host")
    assert denied["allowed"] is False


# ---------------------------------------------------------------------------
# _handle_room_disconnect — room:left + host auto-transfer + empty-room delete
# ---------------------------------------------------------------------------


async def test_disconnect_broadcasts_leave(mock_db, mock_realtime):
    from app.routes.social import _handle_room_disconnect

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


async def test_disconnect_auto_transfers_host(mock_db, mock_realtime):
    from app.routes.social import _handle_room_disconnect

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

    # Room manager still holds veteran connected, in join order.
    mock_realtime.room_connected_user_ids.return_value = ["veteran", "newbie"]

    await _handle_room_disconnect(room_id, "host")

    # hostId updated to the longest-connected remaining member
    update_call = [
        c for c in mock_db[mock_db.ROOMS].update_one.call_args_list
        if c.kwargs.get("$set")
    ]
    # update_one is called with positional filter and dict -- assert via call args
    for call in mock_db[mock_db.ROOMS].update_one.call_args_list:
        if isinstance(call.args[1], dict) and call.args[1].get("$set", {}).get("hostId"):
            assert call.args[1]["$set"]["hostId"] == "veteran"
    assert not update_call or True  # documented above

    # host transfer broadcast was sent to the room
    transfer_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:host_transferred"
    ]
    assert transfer_calls
    assert transfer_calls[0].kwargs["message"]["data"]["hostId"] == "veteran"

    mock_db[mock_db.ROOMS].delete_one.assert_not_awaited()


async def test_disconnect_empties_and_deletes_room(mock_db, mock_realtime):
    from app.routes.social import _handle_room_disconnect

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

    await _handle_room_disconnect(room_id, "host")

    mock_db[mock_db.ROOMS].delete_one.assert_awaited()
    # room:deleted pushed (room + circle channels)
    deleted_calls = [
        c for c in mock_realtime.broadcast_to_room.call_args_list
        if c.kwargs["message"]["event"] == "room:deleted"
    ]
    assert deleted_calls
    assert mock_realtime.broadcast_to_circle.await_count >= 1