"""
Contract tests for the listening-time pipeline:

  POST /play-event            -> writes a PLAYBACK_HISTORIES doc and increments
                                 USERS.statistics.totalListeningTime
  GET  /stats/listening-time  -> aggregates the SAME PLAYBACK_HISTORIES docs back
                                 into total_minutes / daily_breakdown

These tests pin the write/read contract so a future refactor can't silently
desync the two (e.g. writing userId as a string vs reading it as an ObjectId,
or renaming listenDuration/playedAt on only one side).
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from bson import ObjectId

USER_ID = "6630a1c2e4b0a1c2e4b0a1c2"


@pytest.fixture
def mock_db():
    """Mock MongoDB with per-collection children + an aggregate helper."""
    from app.database import mongodb

    db = MagicMock()
    db.USERS = "users"
    db.PLAYBACK_HISTORIES = "playbackhistories"
    db.ACTIVITIES = "activities"

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
            "settings": {"showListeningActivity": False},
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


def _play_event_payload(video_id="dQw4w9WgXcQ", title="Song", artist="Artist", duration=30):
    return {
        "song": {
            "videoId": video_id,
            "title": title,
            "artist": artist,
            "thumbnail": "",
            "duration": 180,
        },
        "listenDuration": duration,
    }


async def test_play_event_writes_history_and_increments_total(client, mock_db):
    resp = await client.post("/play-event", json=_play_event_payload())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True

    hist = mock_db[mock_db.PLAYBACK_HISTORIES]
    hist.insert_one.assert_awaited_once()
    history_entry = hist.insert_one.await_args.args[0]

    # The crucial contract: userId is an ObjectId (identical to how the stats
    # endpoint filters), listenDuration and playedAt are present.
    assert history_entry["userId"] == ObjectId(USER_ID)
    assert history_entry["listenDuration"] == 30
    assert "playedAt" in history_entry and history_entry["playedAt"] is not None
    assert history_entry["song"]["videoId"] == "dQw4w9WgXcQ"

    # statistics.totalListeningTime incremented atomically.
    users = mock_db[mock_db.USERS]
    users.update_one.assert_awaited_once()
    inc_call = users.update_one.await_args
    assert inc_call.args[1] == {"$inc": {"statistics.totalListeningTime": 30}}


async def test_listening_time_stats_aggregates_same_shape_as_play_event(client, mock_db):
    from datetime import datetime

    # The stats endpoint runs an aggregation pipeline over PLAYBACK_HISTORIES.
    # Patch the cursor's async iteration to return the fake grouped doc so we
    # can assert the route surfaces total_minutes derived from listenDuration.
    grouped = {
        "_id": {"date": datetime.utcnow().strftime("%Y-%m-%d")},
        "totalSeconds": 30,
        "songCount": 1,
    }

    async def _agen():
        yield grouped

    cursor = MagicMock()
    cursor.__aiter__ = MagicMock(return_value=_agen())

    aggregate_mock = MagicMock(return_value=cursor)
    mock_db[mock_db.PLAYBACK_HISTORIES].aggregate = aggregate_mock

    resp = await client.get("/stats/listening-time?days=30")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    data = body["data"]
    assert data["total_minutes"] == 0  # 30s // 60

    # Assert the matcher used the same userId representation as the writer.
    pipeline = aggregate_mock.call_args.args[0]
    match = pipeline[0]["$match"]
    assert match["userId"] == ObjectId(USER_ID)
    assert "$gte" in match["playedAt"]
    # And it sums the field the writer emits.
    group = pipeline[1]["$group"]
    assert group["totalSeconds"]["$sum"] == "$listenDuration"
