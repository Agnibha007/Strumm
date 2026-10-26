from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.security import parse_object_id


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


@pytest.fixture
def local_episode_db(monkeypatch):
    episode_id = "64a1b2c3d4e5f67890123456"
    show_id = "64a1b2c3d4e5f67890123457"
    episode = {
        "_id": parse_object_id(episode_id),
        "showId": show_id,
        "title": "Example Podcast Episode",
        "audioUrl": "https://media.example.org/episodes/example.mp3",
        "mimeType": "audio/mpeg",
        "mediaType": "audio",
        "videoUrl": None,
    }
    episode_collection = MagicMock()
    episode_collection.find_one = AsyncMock(return_value=episode)
    show_collection = MagicMock()
    show_collection.find_one = AsyncMock(return_value={"title": "Example Show"})
    database = MagicMock()
    database.__getitem__ = MagicMock(
        side_effect=lambda name: {
            db.PODCAST_EPISODES: episode_collection,
            db.PODCAST_SHOWS: show_collection,
        }.get(name, MagicMock())
    )
    monkeypatch.setattr(db, "get_db", MagicMock(return_value=database))
    return episode_id, episode_collection, show_collection


class MockStreamingResponse:
    def __init__(self, body, headers, status_code=200):
        self.body = body
        self.headers = httpx.Headers(headers)
        self.status_code = status_code
        self.aclose = AsyncMock()

    async def aiter_raw(self):
        if self.body:
            yield self.body


def setup_upstream(monkeypatch, source_url="https://media.example.org/episodes/example.mp3", body=b"podcast audio", content_type="audio/mpeg", extra_headers=None):
    from app.routes import podcast

    headers = {"content-type": content_type, "content-length": str(len(body))}
    if extra_headers:
        headers.update(extra_headers)
    response = MockStreamingResponse(body, headers)
    upstream_client = AsyncMock()
    upstream_client.build_request = MagicMock(return_value=httpx.Request("GET", source_url))
    upstream_client.send = AsyncMock(return_value=response)
    upstream_client.aclose = AsyncMock()
    monkeypatch.setattr(podcast, "assert_public_http_url", lambda url: url)
    monkeypatch.setattr(podcast, "create_pinned_client", MagicMock(return_value=upstream_client))
    return response, upstream_client


@pytest.mark.asyncio
async def test_download_streams_episode_bytes_with_safe_headers(client, local_episode_db, monkeypatch):
    episode_id, _, _ = local_episode_db
    body = b"podcast audio"
    setup_upstream(monkeypatch, body=body)

    async with client:
        response = await client.get(f"/podcasts/episode/{episode_id}/download")

    assert response.status_code == 200
    assert response.content == body
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "Example Podcast Episode.mp3" in response.headers["content-disposition"]
    assert "filename*=UTF-8''Example%20Podcast%20Episode.mp3" in response.headers["content-disposition"]


@pytest.mark.asyncio
async def test_download_resolves_podcast_index_numeric_id(client, monkeypatch):
    from app.routes import podcast
    import app.services.podcast_index as podcast_index

    async def episode_lookup(episode_id):
        return {
            "id": episode_id,
            "showId": "123",
            "title": "Index Episode",
            "audioUrl": "https://media.example.org/index-episode.mp3",
            "mimeType": "audio/mpeg",
            "mediaType": "audio",
            "videoUrl": "",
        }

    monkeypatch.setattr(podcast_index, "get_episode_by_id", episode_lookup)
    monkeypatch.setattr(podcast, "get_podcast_index_show", AsyncMock(return_value={"title": "Index Show"}))
    setup_upstream(monkeypatch, source_url="https://media.example.org/index-episode.mp3", body=b"index audio")

    async with client:
        response = await client.get("/podcasts/episode/12345/download")

    assert response.status_code == 200
    assert response.content == b"index audio"


@pytest.mark.asyncio
async def test_download_rejects_private_source_url(client, local_episode_db, monkeypatch):
    from app.routes import podcast

    episode_id, _, _ = local_episode_db
    monkeypatch.setattr(
        podcast,
        "assert_public_http_url",
        MagicMock(side_effect=ValueError("private URL")),
    )
    monkeypatch.setattr(podcast, "create_pinned_client", MagicMock())

    async with client:
        response = await client.get(f"/podcasts/episode/{episode_id}/download")

    assert response.status_code == 400
    assert "invalid" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_download_rejects_html_source(client, local_episode_db, monkeypatch):
    from app.routes import podcast

    episode_id, _, _ = local_episode_db
    setup_upstream(
        monkeypatch,
        body=b"<html>not audio</html>",
        content_type="text/html",
    )

    async with client:
        response = await client.get(f"/podcasts/episode/{episode_id}/download")

    assert response.status_code == 415


@pytest.mark.asyncio
async def test_download_rejects_files_above_size_limit(client, local_episode_db, monkeypatch):
    from app.routes import podcast

    episode_id, _, _ = local_episode_db
    response = MockStreamingResponse(
        b"small",
        {
            "content-type": "audio/mpeg",
            "content-length": str(podcast.PODCAST_DOWNLOAD_MAX_BYTES + 1),
        },
    )
    upstream_client = AsyncMock()
    upstream_client.build_request = MagicMock(
        return_value=httpx.Request("GET", "https://media.example.org/episodes/example.mp3")
    )
    upstream_client.send = AsyncMock(return_value=response)
    upstream_client.aclose = AsyncMock()
    monkeypatch.setattr(podcast, "assert_public_http_url", lambda url: url)
    monkeypatch.setattr(podcast, "create_pinned_client", MagicMock(return_value=upstream_client))

    async with client:
        result = await client.get(f"/podcasts/episode/{episode_id}/download")

    assert result.status_code == 413


@pytest.mark.asyncio
async def test_download_route_requires_authentication(client, local_episode_db):
    from app.main import app

    previous = app.dependency_overrides.pop(get_current_user, None)
    try:
        async with client:
            response = await client.get("/podcasts/episode/64a1b2c3d4e5f67890123456/download")
        assert response.status_code == 401
    finally:
        if previous is not None:
            app.dependency_overrides[get_current_user] = previous
