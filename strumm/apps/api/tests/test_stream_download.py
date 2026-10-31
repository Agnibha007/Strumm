"""Tests for the server-side song download endpoint (``GET /download/{id}``)."""

import os
import tempfile
from unittest.mock import patch

import pytest

from app.routes import stream


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


def _fake_ytdlp_download_factory(file_bytes: bytes):
    def fake_download(video_id: str):
        tmp_dir = tempfile.mkdtemp(prefix=f"strumm-dl-{video_id}-")
        mp3_path = os.path.join(tmp_dir, "audio.mp3")
        with open(mp3_path, "wb") as fh:
            fh.write(file_bytes)
        return mp3_path, tmp_dir

    return fake_download


@pytest.mark.asyncio
async def test_song_download_streams_mp3(client, monkeypatch):
    monkeypatch.setattr(stream, "_run_ytdlp_download", _fake_ytdlp_download_factory(b"mp3-bytes"))

    async with client:
        response = await client.get("/download/abcdefghijk")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert "attachment" in response.headers.get("content-disposition", "")
    assert response.content == b"mp3-bytes"


@pytest.mark.asyncio
async def test_song_download_rejects_oversized_track(client, monkeypatch):
    monkeypatch.setattr(stream, "_run_ytdlp_download", _fake_ytdlp_download_factory(b"x" * 32))
    monkeypatch.setattr(stream, "SONG_DOWNLOAD_MAX_BYTES", 10)

    async with client:
        response = await client.get("/download/abcdefghijk")

    assert response.status_code == 413
    assert "500 MiB" in response.json()["detail"]


@pytest.mark.asyncio
async def test_song_download_returns_502_when_source_unavailable(client, monkeypatch):
    def failing_download(video_id: str):
        raise RuntimeError("No audio URL could be extracted for " + video_id)

    monkeypatch.setattr(stream, "_run_ytdlp_download", failing_download)

    async with client:
        response = await client.get("/download/abcdefghijk")

    assert response.status_code == 502
    assert "Unable to prepare the song download" in response.json()["detail"]


@pytest.mark.asyncio
async def test_song_download_rejects_invalid_video_id(client, monkeypatch):
    async with client:
        response = await client.get("/download/short")

    assert response.status_code == 400
    assert "Invalid YouTube video ID" in response.json()["detail"]
