"""
Regression tests for share links (the "sharing playlists doesn't work" fix).

The ``create_playlist`` route stores ``userId`` as a ``bson.ObjectId`` while the
JWT subject (``current_user["id"]``) is a string. ``create_share_link`` and
``get_shared_content`` previously compared the two with ``!=`` directly, which
is always ``True`` for ObjectId vs str — so every playlist share failed with
"Playlist not found or not owned by current user." These tests pin the
``str()``-normalized comparison.

  POST /share    (playlist) -> ownership check passes with ObjectId userId.
  GET  /share/{token}      -> private-but-owned playlist still resolves.
  POST /share    (playlist) -> foreign playlist is still rejected.

MongoDB is mocked; no external services are touched.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from bson import ObjectId

USER_ID = "6630a1c2e4b0a1c2e4b0a1c2"
USER_OID = ObjectId(USER_ID)
OTHER_ID = "6630a1c2e4b0a1c2e4b0a1c3"
OTHER_OID = ObjectId(OTHER_ID)

OWNED_PLAYLIST = {
    "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c4"),
    "userId": USER_OID,  # ObjectId, as stored by create_playlist
    "name": "My Mix",
    "visibility": "public",
    "songs": [],
}


@pytest.fixture
def mock_db():
    """Mock MongoDB with per-collection children."""
    from app.database import mongodb

    db = MagicMock()
    db.PLAYLISTS = "playlists"
    db.SHARES = "shares"
    db.LIKED_SONGS = "likedsongs"

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
    mongodb.get_db = MagicMock(return_value=db)
    return db


@pytest.fixture
def client(mock_db):
    """ASGI client authenticated as USER_ID."""
    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return {
            "id": USER_ID,
            "username": "sharer",
            "displayName": "Sharer",
            "email": "sharer@example.com",
            "createdAt": "2025-01-01T00:00:00",
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_create_share_owned_playlist_succeeds_with_objectid_user_id(mock_db, client):
    """A playlist whose userId is an ObjectId still belongs to the user."""
    mock_db[mock_db.PLAYLISTS].find_one = AsyncMock(return_value=OWNED_PLAYLIST)

    res = await client.post("/share", json={
        "contentType": "playlist",
        "contentId": str(OWNED_PLAYLIST["_id"]),
    })
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["data"]["shareUrl"].startswith("/share/")
    assert body["data"]["shareToken"]

    inserted = mock_db[mock_db.SHARES].insert_one.call_args.args[0]
    assert inserted["contentType"] == "playlist"
    assert inserted["contentId"] == str(OWNED_PLAYLIST["_id"])
    assert inserted["userId"] == USER_ID


async def test_create_share_foreign_playlist_rejected(mock_db, client):
    """A playlist owned by another user must be rejected."""
    foreign = {**OWNED_PLAYLIST, "userId": OTHER_OID}
    mock_db[mock_db.PLAYLISTS].find_one = AsyncMock(return_value=foreign)

    res = await client.post("/share", json={
        "contentType": "playlist",
        "contentId": str(foreign["_id"]),
    })
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is False
    assert "not found or not owned" in body["error"]
    mock_db[mock_db.SHARES].insert_one.assert_not_awaited()


async def test_get_shared_private_owned_playlist_resolves(mock_db, client):
    """A private playlist shares fine as long as the sharer owns it."""
    private = {**OWNED_PLAYLIST, "visibility": "private"}
    mock_db[mock_db.SHARES].find_one = AsyncMock(return_value={
        "_id": ObjectId("6630a1c2e4b0a1c2e4b0a1c5"),
        "userId": USER_ID,  # string, as stored by create_share_link
        "contentType": "playlist",
        "contentId": str(private["_id"]),
        "shareToken": "abc123",
        "views": 0,
        "expiry": None,
    })
    mock_db[mock_db.PLAYLISTS].find_one = AsyncMock(return_value=private)

    res = await client.get("/share/abc123")
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["data"]["contentType"] == "playlist"
    assert body["data"]["content"]["name"] == "My Mix"