"""
Tests for podcast resume progress endpoints.

Covers GET/PUT/DELETE /podcasts/progress/{episode_id} and the listing endpoint.
MongoDB is mocked so tests run without external services.
Uses httpx.AsyncClient with ASGITransport directly (same pattern as test_radio.py).
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

PROGRESS_COLLECTION = "podcastprogress"


@pytest.fixture
def mock_db():
    """Mock the MongoDB database with an in-memory podcastprogress collection."""
    db = MagicMock()
    db.PODCAST_PROGRESS = PROGRESS_COLLECTION

    collection = MagicMock()
    store: dict = {}

    async def find_one_side_effect(filter_dict, projection=None):
        if store and all(store.get(k) == v for k, v in filter_dict.items()):
            return {**store}
        return None

    collection.find_one = AsyncMock(side_effect=find_one_side_effect)

    async def update_one_side_effect(filter_dict, update, upsert=False, **kwargs):
        set_vals = update.get("$set", {})
        store.update(filter_dict)
        store.update(
            {
                k: set_vals[k]
                for k in ("positionSeconds", "durationSeconds", "updatedAt")
                if k in set_vals
            }
        )
        return MagicMock()

    collection.update_one = AsyncMock(side_effect=update_one_side_effect)
    collection.delete_one = AsyncMock()

    def find_side_effect(filter_dict, **kwargs):
        entries = [{**store}] if store else []
        cursor = MagicMock()
        cursor.__aiter__.return_value = iter(entries)
        cursor.sort = MagicMock(return_value=cursor)
        return cursor

    collection.find = MagicMock(side_effect=find_side_effect)

    def getitem(name):
        return collection

    db.__getitem__ = MagicMock(side_effect=getitem)
    return db


@pytest.fixture
def client(mock_db):
    """Create a httpx AsyncClient pointed at the FastAPI app."""
    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=mock_db)

    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return {
            "id": "test_user_123",
            "username": "testuser",
            "email": "test@example.com",
            "createdAt": "2025-01-01T00:00:00",
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


class TestPodcastProgress:
    @pytest.mark.asyncio
    async def test_get_progress_when_empty(self, client, mock_db):
        """GET with no saved progress returns positionSeconds 0."""
        async with client:
            resp = await client.get("/podcasts/progress/ep-1")
            data = resp.json()
        assert resp.status_code == 200
        assert data["success"] is True
        assert data["data"]["positionSeconds"] == 0

    @pytest.mark.asyncio
    async def test_put_saves_progress(self, client, mock_db):
        """PUT upserts progress and calls update_one with upsert=True."""
        async with client:
            resp = await client.put(
                "/podcasts/progress/ep-1",
                json={"positionSeconds": 123.5, "durationSeconds": 3600},
            )
            data = resp.json()

        assert resp.status_code == 200
        assert data["success"] is True
        assert data["data"]["episodeId"] == "ep-1"
        assert data["data"]["positionSeconds"] == 123.5

        collection = mock_db[PROGRESS_COLLECTION]
        assert collection.update_one.called
        _, call_kwargs = collection.update_one.call_args
        assert call_kwargs.get("upsert") is True

    @pytest.mark.asyncio
    async def test_put_rejects_negative_position(self, client, mock_db):
        """Negative positions are rejected by validation."""
        async with client:
            resp = await client.put(
                "/podcasts/progress/ep-1",
                json={"positionSeconds": -5},
            )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_delete_clears_progress(self, client, mock_db):
        """DELETE removes the progress entry."""
        async with client:
            resp = await client.delete("/podcasts/progress/ep-1")
            data = resp.json()
        assert resp.status_code == 200
        assert data["success"] is True

        collection = mock_db[PROGRESS_COLLECTION]
        assert collection.delete_one.called
        filter_used = collection.delete_one.call_args[0][0]
        assert filter_used["episodeId"] == "ep-1"

    @pytest.mark.asyncio
    async def test_list_progress(self, client, mock_db):
        """GET /podcasts/progress lists saved entries."""
        async with client:
            await client.put(
                "/podcasts/progress/ep-1",
                json={"positionSeconds": 55, "durationSeconds": 600},
            )
            resp = await client.get("/podcasts/progress")
            data = resp.json()

        assert resp.status_code == 200
        assert data["success"] is True
        progress = data["data"]["progress"]
        assert len(progress) == 1
        assert progress[0]["episodeId"] == "ep-1"
        assert progress[0]["positionSeconds"] == 55
        assert progress[0]["durationSeconds"] == 600
        assert "updatedAt" in progress[0]
