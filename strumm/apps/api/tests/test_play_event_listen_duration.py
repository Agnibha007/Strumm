"""
`POST /play-event` listenDuration handling.

The client measures listening time from media-position deltas, which are floats,
and a media element reports `currentTime === NaN` until its metadata loads.
`JSON.stringify(NaN)` is `null`, so a single unusable position sample used to
reach the API as `"listenDuration": null` and be rejected with a 422
(`int_type`).

That was worse than a dropped event: the client keeps unacknowledged events in a
persisted queue and replays them, so a value that can never become valid was
retried forever while the user's real listening time was silently lost for the
rest of the session.

These tests pin the contract: a duration that is unusable is reported as "+0
seconds, acknowledged" (never an error, never a history row), and a fractional
one is truncated to whole seconds rather than rejected.
"""
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


def make_payload(listen_duration=30, event_id=None):
    payload = {
        "song": {
            "videoId": "dQw4w9WgXcQ",
            "title": "Song",
            "artist": "Artist",
            "thumbnail": "",
            "duration": 180,
        },
        "listenDuration": listen_duration,
    }
    if event_id is not None:
        payload["eventId"] = event_id
    return payload


def history_inserts(mock_db):
    return mock_db["playbackhistories"].insert_one


def users_increments(mock_db):
    return [
        call.args[1]
        for call in mock_db["users"].update_one.await_args_list
        if "$inc" in (call.args[1] or {})
    ]


# --- Unusable values: acknowledge, count nothing, never error ----------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_value",
    [
        pytest.param(None, id="null-from-NaN-position"),
        pytest.param(0, id="zero"),
        pytest.param(-30, id="negative"),
        pytest.param(True, id="bool-true"),
        pytest.param("", id="empty-string"),
        pytest.param("   ", id="whitespace-string"),
        pytest.param("not-a-number", id="non-numeric-string"),
        pytest.param([30], id="list"),
    ],
)
async def test_unusable_listen_duration_is_acknowledged_with_zero(client, mock_db, bad_value):
    """A value that carries no measurable time must not 422.

    A 422 here is not a dropped event — it is a permanently-replayed event that
    stalls the client's whole listening queue.
    """
    resp = await client.post("/play-event", json=make_payload(bad_value))
    assert resp.status_code == 200, f"Expected 200 for {bad_value!r} but got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert body["success"] is True
    assert "+0 seconds" in body["data"]["message"]
    # Nothing was recorded, so no history row and no total-time increment.
    assert history_inserts(mock_db).await_count == 0
    assert users_increments(mock_db) == []


@pytest.mark.asyncio
async def test_null_listen_duration_still_releases_the_idempotency_key(client, mock_db):
    """A 200 is the client's ack: the event leaves the persisted replay queue."""
    resp = await client.post(
        "/play-event", json=make_payload(None, event_id="evt-zero-1")
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is True


# --- Fractional / stringified values: truncate, don't reject ------------------


@pytest.mark.asyncio
async def test_fractional_listen_duration_is_truncated_not_rejected(client, mock_db):
    resp = await client.post("/play-event", json=make_payload(30.7))
    assert resp.status_code == 200, resp.text
    assert "+30 seconds" in resp.json()["data"]["message"]
    assert history_inserts(mock_db).await_count == 1
    assert history_inserts(mock_db).await_args.args[0]["listenDuration"] == 30


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw,expected",
    [
        pytest.param("45", 45, id="numeric-string"),
        pytest.param(45, 45, id="plain-int"),
        pytest.param(0.9, 0, id="sub-second-truncates-to-zero"),
    ],
)
async def test_coerced_listen_duration_counts_exactly(client, mock_db, raw, expected):
    resp = await client.post("/play-event", json=make_payload(raw))
    assert resp.status_code == 200, resp.text
    message = resp.json()["data"]["message"]
    assert f"+{expected} seconds" in message
    if expected == 0:
        assert history_inserts(mock_db).await_count == 0
    else:
        assert history_inserts(mock_db).await_args.args[0]["listenDuration"] == expected


@pytest.mark.asyncio
async def test_truncation_never_inflates_the_total(client, mock_db):
    """Rounding up would let a client over-report listening time for free."""
    resp = await client.post("/play-event", json=make_payload(29.999))
    assert resp.status_code == 200
    assert "+29 seconds" in resp.json()["data"]["message"]


# --- Still validated: the field itself, and the range ceiling ---------------


@pytest.mark.asyncio
async def test_missing_listen_duration_is_still_a_validation_error(client, mock_db):
    payload = make_payload()
    payload.pop("listenDuration")
    resp = await client.post("/play-event", json=payload)
    # Omitting the field entirely is a client bug, not a measurement artefact —
    # unlike an explicit `null`, which is a real value meaning "no measurable
    # time", so it is answered with +0 rather than an error.
    assert resp.status_code == 422
    assert history_inserts(mock_db).await_count == 0


@pytest.mark.asyncio
async def test_out_of_range_listen_duration_is_clamped_not_rejected(client, mock_db):
    """The 300s per-event ceiling still guards the totals pipeline.

    Clamping, not rejecting: rejecting returned `success: false`, which the
    client reads as "not acknowledged" and replays — so a value over the
    ceiling blocked its own queue permanently while logging an ERROR server-side
    for every retry. Clamping keeps the ceiling without losing the event.
    """
    resp = await client.post("/play-event", json=make_payload(5000))
    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True
    assert "+300 seconds" in resp.json()["data"]["message"]
    assert history_inserts(mock_db).await_args.args[0]["listenDuration"] == 300
