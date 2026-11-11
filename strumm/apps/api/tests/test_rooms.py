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


def test_clean_song_keeps_local_audio_url_only_in_dev_guest_mode(monkeypatch):
    from app.services.rooms import clean_song

    song = {
        "videoId": "dQw4w9WgXcQ",
        "title": "Local sync test",
        "artist": "Test",
        "duration": 40,
        "metadata": {"audioUrl": "http://127.0.0.1:8001/strumm-test-tone.wav"},
    }
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("STRUMM_DEV_AUTH", "true")
    assert clean_song(song)["metadata"]["audioUrl"] == song["metadata"]["audioUrl"]

    monkeypatch.setenv("ENVIRONMENT", "production")
    assert "metadata" not in clean_song(song)


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
async def test_dev_guest_presence_has_synthetic_profiles(monkeypatch):
    from app.services.rooms import active_presence

    user_id = "0123456789abcdef01234567"
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("STRUMM_DEV_AUTH", "true")
    database = MagicMock()
    presence = MagicMock()
    presence.find.return_value = AsyncCursor([{"userId": user_id}])
    users = MagicMock()
    users.find.return_value = AsyncCursor([])
    database.__getitem__.side_effect = lambda key: {
        "room_presence": presence,
        "users": users,
    }[key]

    listeners = await active_presence(database, "6630a1c2e4b0a1c2e4b0a1c2")

    assert listeners == [{
        "id": user_id,
        "displayName": f"Local Guest {user_id[-4:]}",
        "username": f"dev_{user_id[-6:]}",
        "avatar": None,
        "avatarMediaId": None,
    }]


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
    assert inserted["playbackState"]["startAt"] is None
    assert inserted["playbackState"]["sequence"] == 0
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
    from app.services.realtime.connection_manager import manager

    monkeypatch.setattr(manager, "room_connected_clients", lambda room_id: [
        {"userId": "host-id", "deviceId": "a" * 32},
        {"userId": "listener-id", "deviceId": "b" * 32},
    ])

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
            deviceId="a" * 32,
        ),
        {"id": "host-id"},
    )
    update = rooms.update_one.call_args.args[1]
    assert update["$set"]["playbackState"]["playing"] is False
    assert update["$set"]["playbackState"]["targetPlaying"] is True
    assert update["$set"]["playbackState"]["phase"] == "preparing"
    assert update["$set"]["playbackState"]["sequence"] == 1
    assert update["$set"]["playbackState"]["startAt"] is None
    assert update["$set"]["playbackState"]["participants"] == ["a" * 32, "b" * 32]
    assert update["$set"]["playbackState"]["participantUsers"] == {
        "a" * 32: "host-id", "b" * 32: "listener-id",
    }
    assert update["$set"]["playbackState"]["readyDeviceIds"] == []
    assert update["$set"]["currentTrack"]["videoId"] == "dQw4w9WgXcQ"
    assert update["$pull"]["queue"]["videoId"] == "dQw4w9WgXcQ"


@pytest.mark.asyncio
async def test_direct_playback_persists_snapshot_without_broadcasting(monkeypatch):
    import time
    from app.database import mongodb
    from app.routes import rooms as rooms_route
    from app.routes.rooms import PlaybackBody, update_playback

    room_id = ObjectId()
    room = {
        "_id": room_id,
        "hostId": "host-id",
        "members": ["host-id", "listener-id"],
        "queue": [{"videoId": "dQw4w9WgXcQ"}],
        "playbackState": {"playing": True, "sequence": 4},
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
    monkeypatch.setattr(rooms_route, "get_room", AsyncMock(return_value=room))
    monkeypatch.setattr(rooms_route, "serialize_room", AsyncMock(return_value={"id": str(room_id)}))
    broadcast = AsyncMock()
    monkeypatch.setattr(rooms_route, "_broadcast_room_state", broadcast)

    result = await update_playback(
        str(room_id),
        PlaybackBody(
            song={"videoId": "dQw4w9WgXcQ", "title": "Test", "artist": "Test", "duration": 45},
            playing=False,
            timestamp=18.25,
            direct=True,
            sequence=5,
        ),
        {"id": "host-id"},
    )

    update = rooms.update_one.call_args.args[1]
    state = update["$set"]["playbackState"]
    assert state["phase"] == "committed"
    assert state["playing"] is False
    assert state["timestamp"] == 18.25
    assert state["sequence"] == 5
    assert state["startAt"] >= int(time.time() * 1000) - 1000
    assert update["$set"]["currentTrack"]["videoId"] == "dQw4w9WgXcQ"
    assert update["$pull"]["queue"]["videoId"] == "dQw4w9WgXcQ"
    broadcast.assert_not_awaited()
    assert result["data"]["id"] == str(room_id)


@pytest.mark.asyncio
async def test_direct_playback_ignores_out_of_order_snapshot(monkeypatch):
    from app.database import mongodb
    from app.routes import rooms as rooms_route
    from app.routes.rooms import PlaybackBody, update_playback

    room_id = ObjectId()
    room = {
        "_id": room_id,
        "hostId": "host-id",
        "members": ["host-id"],
        "queue": [],
        "playbackState": {"playing": True, "sequence": 8},
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
    monkeypatch.setattr(rooms_route, "serialize_room", AsyncMock(return_value={"id": str(room_id)}))

    result = await update_playback(
        str(room_id),
        PlaybackBody(song=None, playing=False, timestamp=4, direct=True, sequence=7),
        {"id": "host-id"},
    )

    rooms.update_one.assert_not_awaited()
    assert result["data"]["id"] == str(room_id)


@pytest.mark.asyncio
async def test_playback_barrier_commits_only_after_all_expected_devices_are_ready(monkeypatch):
    import time
    from app.database import mongodb
    from app.routes import rooms as rooms_route
    from app.routes.rooms import PlaybackReadyBody, playback_ready
    from app.services.realtime.connection_manager import manager

    monkeypatch.setattr(manager, "room_connected_clients", lambda room_id: [
        {"userId": "host-id", "deviceId": "a" * 32},
        {"userId": "listener-id", "deviceId": "b" * 32},
    ])
    room_id = ObjectId()
    room = {
        "_id": room_id,
        "hostId": "host-id",
        "members": ["host-id", "listener-id"],
        "playbackState": {
            "playing": False,
            "targetPlaying": True,
            "timestamp": 32.5,
            "updatedAt": None,
            "startAt": None,
            "sequence": 9,
            "phase": "preparing",
            "commandAt": int(time.time() * 1000),
            "participants": ["a" * 32, "b" * 32],
            "participantUsers": {"a" * 32: "host-id", "b" * 32: "listener-id"},
            "readyDeviceIds": ["a" * 32, "b" * 32],
        },
    }
    database = MagicMock()
    database.__getitem__.return_value = MagicMock()
    rooms = database.__getitem__.return_value
    rooms.update_one = AsyncMock()
    monkeypatch.setattr(mongodb, "get_db", lambda: database)
    monkeypatch.setattr(rooms_route, "get_room", AsyncMock(return_value=room))
    monkeypatch.setattr(rooms_route, "serialize_room", AsyncMock(return_value={"id": str(room_id), "playbackState": room["playbackState"]}))
    monkeypatch.setattr(rooms_route, "_broadcast_room_state", AsyncMock())

    await playback_ready(str(room_id), PlaybackReadyBody(sequence=9, deviceId="b" * 32), {"id": "listener-id"})

    commit_update = rooms.update_one.call_args_list[-1].args[1]["$set"]
    assert commit_update["playbackState.phase"] == "committed"
    assert commit_update["playbackState.playing"] is True
    assert commit_update["playbackState.timestamp"] == 32.5
    assert commit_update["playbackState.startAt"] >= int(time.time() * 1000) + 1000


@pytest.mark.asyncio
async def test_playback_barrier_does_not_commit_before_every_device_is_ready(monkeypatch):
    import time
    from app.database import mongodb
    from app.routes import rooms as rooms_route
    from app.routes.rooms import PlaybackReadyBody, playback_ready
    from app.services.realtime.connection_manager import manager

    monkeypatch.setattr(manager, "room_connected_clients", lambda room_id: [
        {"userId": "host-id", "deviceId": "a" * 32},
        {"userId": "listener-id", "deviceId": "b" * 32},
    ])
    room_id = ObjectId()
    room = {
        "_id": room_id,
        "hostId": "host-id",
        "members": ["host-id", "listener-id"],
        "playbackState": {
            "playing": True,
            "targetPlaying": False,
            "timestamp": 61.0,
            "startAt": None,
            "sequence": 10,
            "phase": "preparing",
            "commandAt": int(time.time() * 1000),
            "participants": ["a" * 32, "b" * 32],
            "participantUsers": {"a" * 32: "host-id", "b" * 32: "listener-id"},
            "readyDeviceIds": ["a" * 32],
        },
    }
    database = MagicMock()
    rooms = MagicMock()
    rooms.update_one = AsyncMock()
    database.__getitem__.return_value = rooms
    monkeypatch.setattr(mongodb, "get_db", lambda: database)
    monkeypatch.setattr(rooms_route, "get_room", AsyncMock(return_value=room))
    monkeypatch.setattr(rooms_route, "serialize_room", AsyncMock(return_value={"id": str(room_id)}))
    monkeypatch.setattr(rooms_route, "_broadcast_room_state", AsyncMock())

    await playback_ready(str(room_id), PlaybackReadyBody(sequence=10, deviceId="b" * 32), {"id": "listener-id"})

    assert rooms.update_one.await_count == 1
    update = rooms.update_one.call_args.args[1]
    assert "$addToSet" in update
    assert "$set" not in update


@pytest.mark.asyncio
async def test_dev_guest_auth_requires_explicit_local_opt_in(monkeypatch):
    from fastapi import BackgroundTasks, HTTPException
    from app.routes import dependencies
    get_current_user = dependencies.get_current_user

    monkeypatch.setattr(dependencies, "decode_access_token", lambda token: None)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("STRUMM_DEV_AUTH", "true")
    user_id = "0123456789abcdef01234567"
    guest = await get_current_user(BackgroundTasks(), authorization=None, dev_user_id=user_id)
    assert guest["id"] == user_id
    assert guest["username"].startswith("dev_")

    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(HTTPException) as error:
        await get_current_user(BackgroundTasks(), authorization=None, dev_user_id=user_id)
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_websocket_dev_guest_token_is_local_only(monkeypatch):
    from app.services.realtime import websocket as ws_route

    user_id = "0123456789abcdef01234567"
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("STRUMM_DEV_AUTH", "true")
    payload = await ws_route._verify_token(f"dev:{user_id}")
    assert payload["id"] == user_id

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(ws_route, "decode_access_token", lambda token: None)
    assert await ws_route._verify_token(f"dev:{user_id}") is None


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


@pytest.mark.asyncio
async def test_host_can_leave_without_deleting_room(monkeypatch):
    from app.database import mongodb
    from app.routes import rooms as room_routes
    from app.routes.rooms import LeaveRoomBody, leave_room

    room = {"_id": ObjectId(), "hostId": "host-id", "members": ["host-id"]}
    rooms = MagicMock()
    rooms.delete_one = AsyncMock()
    presence = MagicMock()
    presence.delete_one = AsyncMock()
    database = MagicMock()
    database.__getitem__.side_effect = lambda key: {"rooms": rooms, "room_presence": presence}[key]
    monkeypatch.setattr(mongodb, "get_db", lambda: database)
    monkeypatch.setattr(room_routes, "get_room", AsyncMock(return_value=room))

    result = await leave_room(str(room["_id"]), LeaveRoomBody(delete_room=False), {"id": "host-id"})

    assert result["data"]["deleted"] is False
    rooms.delete_one.assert_not_awaited()
    presence.delete_one.assert_awaited_once()


@pytest.mark.asyncio
async def test_host_can_delete_room_for_everyone_when_leaving(monkeypatch):
    from app.database import mongodb
    from app.routes import rooms as room_routes
    from app.routes.rooms import LeaveRoomBody, leave_room
    from app.services.realtime.connection_manager import manager

    room = {"_id": ObjectId(), "hostId": "host-id", "members": ["host-id"]}
    rooms = MagicMock()
    rooms.delete_one = AsyncMock()
    presence = MagicMock()
    presence.delete_one = AsyncMock()
    presence.delete_many = AsyncMock()
    database = MagicMock()
    database.__getitem__.side_effect = lambda key: {"rooms": rooms, "room_presence": presence}[key]
    monkeypatch.setattr(mongodb, "get_db", lambda: database)
    monkeypatch.setattr(room_routes, "get_room", AsyncMock(return_value=room))
    broadcast = AsyncMock()
    monkeypatch.setattr(manager, "broadcast_to_room", broadcast)

    result = await leave_room(str(room["_id"]), LeaveRoomBody(delete_room=True), {"id": "host-id"})

    assert result["data"]["deleted"] is True
    rooms.delete_one.assert_awaited_once()
    presence.delete_many.assert_awaited_once_with({"roomId": str(room["_id"])})
    broadcast.assert_awaited_once()
