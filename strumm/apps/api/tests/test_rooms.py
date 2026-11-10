from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from bson import ObjectId

from app.services.rooms import clean_song, new_join_code


def test_join_codes_are_six_characters_and_avoid_ambiguous_letters():
    code = new_join_code()
    assert len(code) == 6
    assert all(char in "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" for char in code)


def test_song_payload_is_reduced_to_safe_fields():
    song = clean_song({
        "videoId": "dQw4w9WgXcQ",
        "title": "  Never Gonna Give You Up  ",
        "artist": "Rick Astley",
        "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "duration": 213,
        "unexpected": "discard me",
    })
    assert song == {
        "videoId": "dQw4w9WgXcQ",
        "title": "Never Gonna Give You Up",
        "artist": "Rick Astley",
        "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "duration": 213.0,
    }
    assert clean_song({"videoId": "not-a-youtube-id"}) is None


class AsyncCursor:
    def __init__(self, rows):
        self.rows = rows

    def __aiter__(self):
        self._iterator = iter(self.rows)
        return self

    async def __anext__(self):
        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration


@pytest.mark.asyncio
async def test_active_presence_uses_database_leases_and_returns_profiles():
    from app.services.rooms import active_presence

    room_id = "6630a1c2e4b0a1c2e4b0a1c2"
    user_id = "6630a1c2e4b0a1c2e4b0a1c3"
    database = MagicMock()
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([{"userId": user_id}, {"userId": user_id}])
    users = MagicMock()
    users.find.return_value = AsyncCursor([{
        "_id": ObjectId(user_id),
        "displayName": "Listener One",
        "username": "listener",
        "avatar": None,
    }])
    database.__getitem__.side_effect = lambda key: {
        "room_presence": presence,
        "users": users,
    }[key]

    listeners = await active_presence(database, room_id)

    assert listeners == [{
        "id": user_id,
        "displayName": "Listener One",
        "username": "listener",
        "avatar": None,
        "avatarMediaId": None,
    }]
    assert presence.find.call_args.args[0]["roomId"] == room_id


@pytest.mark.asyncio
async def test_create_room_persists_host_and_empty_playback_state(monkeypatch):
    from app.database import mongodb
    from app.routes.rooms import CreateRoomBody, create_room

    room_id = ObjectId()
    rooms = MagicMock()
    rooms.find_one = AsyncMock(return_value=None)
    rooms.insert_one = AsyncMock(return_value=SimpleNamespace(inserted_id=room_id))
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([])
    users = MagicMock()
    database = MagicMock()
    database.__getitem__.side_effect = lambda key: {
        "rooms": rooms, "room_presence": presence, "users": users,
    }[key]
    monkeypatch.setattr(mongodb, "get_db", lambda: database)

    result = await create_room(
        CreateRoomBody(name=" Friday night "),
        {"id": "host-id", "displayName": "Host"},
    )

    inserted = rooms.insert_one.call_args.args[0]
    assert inserted["name"] == "Friday night"
    assert inserted["hostId"] == "host-id"
    assert inserted["members"] == ["host-id"]
    assert inserted["playbackState"]["playing"] is False
    assert result["data"]["id"] == str(room_id)


@pytest.mark.asyncio
async def test_join_requires_the_room_code_for_new_members(monkeypatch):
    from fastapi import HTTPException
    from app.database import mongodb
    from app.routes.rooms import JoinRoomBody, join_room

    room = {
        "_id": ObjectId(),
        "hostId": "host-id",
        "members": ["host-id"],
        "joinCode": "ABC234",
        "queue": [],
    }
    rooms = MagicMock()
    rooms.find_one = AsyncMock(return_value=room)
    rooms.update_one = AsyncMock()
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([])
    users = MagicMock()
    database = MagicMock()
    database.__getitem__.side_effect = lambda key: {
        "rooms": rooms, "room_presence": presence, "users": users,
    }[key]
    monkeypatch.setattr(mongodb, "get_db", lambda: database)

    with pytest.raises(HTTPException) as error:
        await join_room(str(room["_id"]), JoinRoomBody(code="BAD234"), {"id": "listener-id"})
    assert error.value.status_code == 403

    await join_room(str(room["_id"]), JoinRoomBody(code="ABC234"), {"id": "listener-id"})
    assert rooms.update_one.await_count == 1


@pytest.mark.asyncio
async def test_heartbeat_writes_a_database_presence_lease(monkeypatch):
    from app.database import mongodb
    from app.routes.rooms import room_heartbeat

    room = {
        "_id": ObjectId(),
        "hostId": "host-id",
        "members": ["host-id"],
        "joinCode": "ABC234",
        "queue": [],
    }
    rooms = MagicMock()
    rooms.find_one = AsyncMock(return_value=room)
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([])
    presence.update_one = AsyncMock()
    users = MagicMock()
    database = MagicMock()
    database.__getitem__.side_effect = lambda key: {
        "rooms": rooms, "room_presence": presence, "users": users,
    }[key]
    monkeypatch.setattr(mongodb, "get_db", lambda: database)

    result = await room_heartbeat(str(room["_id"]), {"id": "host-id"})

    query = presence.update_one.call_args.args[0]
    update = presence.update_one.call_args.args[1]
    assert query == {"roomId": str(room["_id"]), "userId": "host-id"}
    assert update["$set"]["lastSeenAt"]
    assert update["$set"]["expiresAt"] > update["$set"]["lastSeenAt"]
    assert result["data"]["listenerCount"] == 0


@pytest.mark.asyncio
async def test_playback_update_is_host_only_and_persists_state(monkeypatch):
    from fastapi import HTTPException
    from app.database import mongodb
    from app.routes.rooms import PlaybackBody, update_playback

    room = {
        "_id": ObjectId(),
        "hostId": "host-id",
        "members": ["host-id", "listener-id"],
        "joinCode": "ABC234",
        "queue": [{"videoId": "dQw4w9WgXcQ"}],
    }
    rooms = MagicMock()
    rooms.find_one = AsyncMock(return_value=room)
    rooms.update_one = AsyncMock()
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([])
    users = MagicMock()
    database = MagicMock()
    database.__getitem__.side_effect = lambda key: {
        "rooms": rooms, "room_presence": presence, "users": users,
    }[key]
    monkeypatch.setattr(mongodb, "get_db", lambda: database)

    with pytest.raises(HTTPException) as error:
        await update_playback(
            str(room["_id"]),
            PlaybackBody(song=None, playing=True, timestamp=0),
            {"id": "listener-id"},
        )
    assert error.value.status_code == 403

    await update_playback(
        str(room["_id"]),
        PlaybackBody(
            song={
                "videoId": "dQw4w9WgXcQ",
                "title": "Never Gonna Give You Up",
                "artist": "Rick Astley",
                "thumbnail": "",
                "duration": 213,
            },
            playing=True,
            timestamp=12,
        ),
        {"id": "host-id"},
    )
    update = rooms.update_one.call_args.args[1]
    assert update["$set"]["playbackState"]["playing"] is True
    assert update["$set"]["playbackState"]["sequence"] == 1
    assert update["$set"]["currentTrack"]["videoId"] == "dQw4w9WgXcQ"
    assert update["$pull"]["queue"]["videoId"] == "dQw4w9WgXcQ"


@pytest.mark.asyncio
async def test_room_serialization_marks_host_for_authenticated_viewer():
    from app.services.rooms import serialize_room

    database = MagicMock()
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([])
    database.__getitem__.return_value = presence
    room = {
        "_id": ObjectId(),
        "hostId": "host-id",
        "hostName": "Host",
        "members": ["host-id", "listener-id"],
        "queue": [],
    }

    host_view = await serialize_room(database, room, "host-id")
    listener_view = await serialize_room(database, room, "listener-id")

    assert host_view["isHost"] is True
    assert listener_view["isHost"] is False
    assert host_view["hostId"] == listener_view["hostId"] == "host-id"
