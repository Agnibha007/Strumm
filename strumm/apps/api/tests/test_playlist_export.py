"""Tests for playlist CSV export and the daily playlist-export quota."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routes import playlist


@pytest.fixture
def mock_user():
    return {
        "id": "64a1b2c3d4e5f67890123456",
        "username": "testuser",
        "email": "test@example.com",
        "createdAt": "2025-01-01T00:00:00",
    }


@pytest.fixture
def client(mock_user):
    from app.main import app
    from app.routes.dependencies import get_current_user

    previous = app.dependency_overrides.get(get_current_user)

    async def override_current_user():
        return mock_user

    app.dependency_overrides[get_current_user] = override_current_user
    from httpx import ASGITransport, AsyncClient

    test_client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    yield test_client
    if previous is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = previous


def make_mock_db(playlist):
    database = MagicMock()
    collection = MagicMock()
    collection.find_one = AsyncMock(return_value=playlist)
    database.__getitem__.return_value = collection
    database.PLAYLISTS = "playlists"
    return database


@pytest.mark.asyncio
async def test_export_playlist_returns_spotify_compatible_csv(client, monkeypatch):
    playlist_doc = {
        "_id": "64a1b2c3d4e5f67890123456",
        "id": "64a1b2c3d4e5f67890123456",
        "userId": "64a1b2c3d4e5f67890123456",
        "name": "Test Playlist",
        "visibility": "public",
        "songs": [
            {"videoId": "abcdefghijk", "title": "Track One", "artist": "Artist One", "metadata": {"album": "Album One"}},
            {"videoId": "klmnopqrstuvwx", "title": "Track Two", "artist": "Artist Two", "metadata": {}},
        ],
    }
    monkeypatch.setattr(playlist, "try_consume_playlist_export", _quota_ok)
    monkeypatch.setattr(playlist.db, "get_db", lambda: make_mock_db(playlist_doc))

    async with client:
        response = await client.get("/playlists/64a1b2c3d4e5f67890123456/export")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers.get("content-disposition", "")
    body = response.text
    lines = [line for line in body.strip().split("\n") if line]
    assert lines[0].split(",") == ["title", "artist", "album"]
    assert "Track One" in body
    assert "Artist One" in body
    assert "Album One" in body
    assert "Track Two" in body


@pytest.mark.asyncio
async def test_export_playlist_returns_404_when_missing(client, monkeypatch):
    monkeypatch.setattr(playlist, "try_consume_playlist_export", _quota_ok)
    monkeypatch.setattr(playlist.db, "get_db", lambda: make_mock_db(None))

    async with client:
        response = await client.get("/playlists/64a1b2c3d4e5f67890123457/export")

    assert response.status_code == 404
    assert "Playlist not found" in response.json()["detail"]


@pytest.mark.asyncio
async def test_export_playlist_rejects_when_daily_quota_exceeded(client, monkeypatch):
    monkeypatch.setattr(playlist, "try_consume_playlist_export", _quota_exceeded)
    monkeypatch.setattr(playlist.db, "get_db", lambda: make_mock_db({"_id": "64a1b2c3d4e5f67890123456", "userId": "64a1b2c3d4e5f67890123456", "visibility": "public", "songs": []}))

    async with client:
        response = await client.get("/playlists/64a1b2c3d4e5f67890123456/export")

    assert response.status_code == 429
    assert "Daily playlist export limit" in response.json()["detail"]


async def _quota_ok(user_id: str) -> bool:
    return True


async def _quota_exceeded(user_id: str) -> bool:
    return False
