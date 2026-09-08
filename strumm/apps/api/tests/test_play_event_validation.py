import pytest
from unittest.mock import AsyncMock, MagicMock
from bson import ObjectId

USER_ID = "6630a1c2e4b0a1c2e4b0a1c2"


@pytest.fixture
def mock_db():
    from app.database import mongodb

    db = MagicMock()
    db.USERS = "users"
    db.PLAYBACK_HISTORIES = "playbackhistories"
    db.ACTIVITIES = "activities"
    db.PODCAST_EPISODES = "podcastepisodes"
    db.PODCAST_SHOWS = "podcastshows"

    children: dict = {}

    def _child(key: str):
        if key not in children:
            c = MagicMock()
            c.insert_one = AsyncMock()
            c.update_one = AsyncMock()
            c.find_one = AsyncMock(return_value=None)
            children[key] = c
        return children[key]

    db.__getitem__.side_effect = _child
    mongodb.get_db = MagicMock(return_value=db)
    return db


@pytest.fixture
def client(mock_db):
    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return {
            "id": USER_ID,
            "username": "listener",
            "displayName": "Listener",
            "email": "listener@example.com",
            "createdAt": "2025-01-01T00:00:00",
            "settings": {"showListeningActivity": False},
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


def make_payload(video_id="dQw4w9WgXcQ", title="Song", artist="Artist", duration=30, listen_duration=30):
    payload = {
        "song": {
            "title": title,
            "artist": artist,
            "thumbnail": "",
            "duration": duration,
        },
        "listenDuration": listen_duration,
    }
    if video_id is not None:
        payload["song"]["videoId"] = video_id
    return payload


@pytest.mark.asyncio
async def test_play_event_accepts_youtube_id(client, mock_db):
    resp = await client.post("/play-event", json=make_payload(video_id="dQw4w9WgXcQ"))
    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_play_event_accepts_numeric_podcast_id(client, mock_db):
    """PodcastIndex catalog produces numeric episode IDs like podcast-16792345."""
    resp = await client.post("/play-event", json=make_payload(video_id="podcast-16792345"))
    assert resp.status_code == 200, f"Expected 200 but got {resp.status_code}: {resp.text}"
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_play_event_accepts_hex_objectid_podcast_id(client, mock_db):
    """RSS imported podcasts use 24-character hex ObjectIds."""
    resp = await client.post("/play-event", json=make_payload(video_id="podcast-64a1b2c3d4e5f67890123456"))
    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_play_event_accepts_empty_and_whitespace_video_id(client, mock_db):
    for empty_val in ["", "   ", None]:
        resp = await client.post("/play-event", json=make_payload(video_id=empty_val))
        assert resp.status_code == 200, f"Failed for videoId={empty_val!r}: {resp.text}"


@pytest.mark.asyncio
async def test_play_event_rejects_malformed_video_id(client, mock_db):
    resp = await client.post("/play-event", json=make_payload(video_id="invalid-not-youtube-not-podcast"))
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_play_event_rejects_empty_title(client, mock_db):
    resp = await client.post("/play-event", json=make_payload(title="   "))
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_play_event_rejects_empty_artist(client, mock_db):
    resp = await client.post("/play-event", json=make_payload(artist=""))
    assert resp.status_code == 422
