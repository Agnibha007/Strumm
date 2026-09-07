"""
Contract tests for the automatic "Liked Songs" playlist (Feature 2).

  POST /liked (toggle like)  -> updates LIKED_SONGS AND keeps the user's
                                special "liked" PLAYLISTS doc in sync.
  GET  /liked (first access) -> lazily materializes the special playlist from
                                existing likes (backfill).

The sync is implemented via _sync_liked_songs_playlist() in app.routes.user,
so these tests pin that the auto playlist is (a) created on first toggle,
(b) rebuilt to match the full liked set, and (c) flagged special so the
playlist routes treat it as non-user-editable.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from bson import ObjectId

USER_ID = "6630a1c2e4b0a1c2e4b0a1c2"
USER_OID = ObjectId(USER_ID)


@pytest.fixture
def mock_db():
    """Mock MongoDB with per-collection children."""
    from app.database import mongodb

    db = MagicMock()
    db.LIKED_SONGS = "likedsongs"
    db.PLAYLISTS = "playlists"
    db.USERS = "users"

    children: dict = {}

    def _cursor(docs=None):
        cursor = AsyncMock()
        cursor.to_list = AsyncMock(return_value=docs or [])
        cursor.sort = MagicMock(return_value=cursor)
        cursor.limit = MagicMock(return_value=cursor)
        cursor.skip = MagicMock(return_value=cursor)
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
    mongodb.get_db = MagicMock(return_value=db)
    return db


@pytest.fixture
def client(mock_db):
    """ASGI client with an authenticated user whose id is a valid ObjectId."""
    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return {
            "id": USER_ID,
            "username": "listener",
            "displayName": "Listener",
            "email": "listener@example.com",
            "createdAt": "2025-01-01T00:00:00",
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_sync_creates_special_playlist_on_first_toggle(mock_db, client):
    """Toggling a like for a user with no liked playlist creates one."""
    existing_like = None
    mock_db[mock_db.LIKED_SONGS].find_one = AsyncMock(return_value=existing_like)
    mock_db[mock_db.LIKED_SONGS].insert_one = AsyncMock()

    song = {
        "videoId": "dQw4w9WgXcQ",
        "title": "Test Track",
        "artist": "Test Artist",
        "thumbnail": "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "duration": 210,
    }
    # After insert_one, the sync rebuild queries liked songs and must see it.
    cursor = AsyncMock()
    cursor.sort = MagicMock(return_value=cursor)
    docs = [{"song": song}]

    async def _iterate(mock_self):
        for d in docs:
            yield d

    cursor.__aiter__ = _iterate
    mock_db[mock_db.LIKED_SONGS].find = MagicMock(return_value=cursor)
    res = await client.post("/liked", json=song)
    assert res.status_code == 200
    body = res.json()["data"]
    assert body["liked"] is True

    # The special playlist must be created for this user.
    mock_db[mock_db.PLAYLISTS].find_one.assert_awaited()
    insert_calls = mock_db[mock_db.PLAYLISTS].insert_one.call_args_list
    assert insert_calls
    inserted = insert_calls[0].args[0]
    assert inserted["special"] == "liked"
    assert inserted["userId"] == USER_OID
    assert inserted["name"] == "Liked Songs"
    assert inserted["songs"] == [song]
    assert inserted["visibility"] == "private"


async def test_sync_rebuilds_playlist_on_unlike(mock_db, client):
    """Unliking removes the song from the auto playlist too."""
    existing = {"_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c3"), "userId": USER_ID}
    mock_db[mock_db.LIKED_SONGS].find_one = AsyncMock(return_value=existing)
    mock_db[mock_db.LIKED_SONGS].delete_one = AsyncMock()

    # The playlist already exists; rebuild keeps only the remaining likes.
    playlist_doc = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c4"),
        "userId": USER_OID,
        "special": "liked",
        "songs": [],
    }
    mock_db[mock_db.PLAYLISTS].find_one = AsyncMock(return_value=playlist_doc)
    mock_db[mock_db.PLAYLISTS].update_one = AsyncMock()

    song = {"videoId": "dQw4w9WgXcQ", "title": "Test Track", "artist": "Test Artist", "thumbnail": "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "duration": 210}
    res = await client.post("/liked", json=song)
    assert res.status_code == 200
    assert res.json()["data"]["liked"] is False

    # After the like is deleted, the sync queries liked songs (now empty) and
    # sets the special playlist's songs to the empty list.
    from app.database import mongodb

    rebuild_calls = [
        c
        for c in mock_db[mock_db.PLAYLISTS].update_one.call_args_list
        if isinstance(c.args[1], dict) and "songs" in c.args[1].get("$set", {})
    ]
    assert rebuild_calls
    assert rebuild_calls[0].args[1]["$set"]["songs"] == []


async def test_sync_uses_liked_order_newest_first(mock_db):
    """The rebuilt playlist preserves newest-first order from likedAt."""
    from app.routes.user import _sync_liked_songs_playlist

    docs = [
        {"song": {"videoId": "older"}, "likedAt": "2025-01-01T00:00:00"},
        {"song": {"videoId": "newer"}, "likedAt": "2025-01-02T00:00:00"},
    ]
    cursor = AsyncMock()
    cursor.sort = MagicMock(return_value=cursor)

    async def _iterate(mock_self):
        for d in docs:
            yield d

    cursor.__aiter__ = _iterate
    mock_db[mock_db.LIKED_SONGS].find = MagicMock(return_value=cursor)

    playlist = {
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c5"),
        "userId": USER_OID,
        "special": "liked",
    }
    mock_db[mock_db.PLAYLISTS].find_one = AsyncMock(return_value=playlist)
    mock_db[mock_db.PLAYLISTS].update_one = AsyncMock()

    await _sync_liked_songs_playlist(mock_db, USER_ID, USER_OID)

    rebuild = [
        c
        for c in mock_db[mock_db.PLAYLISTS].update_one.call_args_list
        if isinstance(c.args[1], dict) and "songs" in c.args[1].get("$set", {})
    ]
    assert rebuild
    assert [s["videoId"] for s in rebuild[0].args[1]["$set"]["songs"]] == ["older", "newer"]