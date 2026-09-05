"""
Idempotency contract for POST /play-event.

The frontend trackers now attach a client-generated ``eventId`` (idempotency
key) to every listening flush, and relies on the backend to never count the
same event twice even if a retry lands after the first response was lost.
That guarantee is backed by a unique sparse index on playbackhistories.eventId
and an *insert-first claim*: the history insert itself is the claim, so a
DuplicateKeyError short-circuits the $inc.

These tests pin:
  * eventId is persisted with the history row
  * retrying the SAME eventId counts the seconds once (ack-lost scenario)
  * two CONCURRENT requests with the SAME eventId still count once
  * concurrent requests with DIFFERENT eventIds both count (no lost updates)
  * omitting eventId preserves legacy behavior (every request counts)
  * oversized listenDuration values are rejected before any write
"""

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

USER_ID = "6630a1c2e4b0a1c2e4b0a1c2"


def make_payload(duration=30, event_id=None):
    payload = {
        "song": {
            "videoId": "dQw4w9WgXcQ",
            "title": "Song",
            "artist": "Artist",
            "thumbnail": "",
            "duration": 180,
        },
        "listenDuration": duration,
    }
    if event_id:
        payload["eventId"] = event_id
    return payload


class FakeHistories:
    """playbackhistories collection with real unique-eventId insert semantics."""

    def __init__(self):
        self.docs = []

    async def insert_one(self, doc):
        for existing in self.docs:
            if existing.get("eventId") and existing["eventId"] == doc.get("eventId"):
                raise DuplicateKeyError({
                    "errmsg": "E11000 duplicate key error index: playbackhistories.eventId",
                    "code": 11000,
                    "keyPattern": {"eventId": 1},
                    "keyValue": {"eventId": doc["eventId"]},
                })
        self.docs.append(dict(doc))
        return MagicMock(inserted_id=ObjectId())


class FakeUsers:
    """users collection capturing atomic $inc ops."""

    def __init__(self):
        self.increments = []

    async def update_one(self, filt, update):
        if "$inc" in update:
            self.increments.append(update["$inc"]["statistics.totalListeningTime"])
        return MagicMock(modified_count=1)


class FakeActivities:
    async def update_one(self, *args, **kwargs):
        return MagicMock(modified_count=1)


class FakeDb:
    PLAYBACK_HISTORIES = "playbackhistories"
    USERS = "users"

    def __init__(self):
        self.histories = FakeHistories()
        self.users = FakeUsers()
        self.activities = FakeActivities()

    def __getitem__(self, name):
        return {
            "playbackhistories": self.histories,
            "users": self.users,
            "activities": self.activities,
        }[name]


@pytest.fixture
def fake_db():
    return FakeDb()


@pytest.fixture
def client(fake_db):
    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=fake_db)

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
            "statistics": {"totalListeningTime": 0},
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


async def _post(client, payload):
    return await client.post("/play-event", json=payload)


async def test_event_id_persisted_and_increments_once(client, fake_db):
    resp = await _post(client, make_payload(duration=30, event_id="evt-001"))
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    assert fake_db.users.increments == [30]
    assert len(fake_db.histories.docs) == 1
    assert fake_db.histories.docs[0]["eventId"] == "evt-001"


async def test_retry_with_same_event_id_counts_once(client, fake_db):
    """A lost response + client retry must not double-count the seconds."""
    first = await _post(client, make_payload(duration=30, event_id="evt-002"))
    assert first.json()["success"] is True
    retry = await _post(client, make_payload(duration=30, event_id="evt-002"))
    assert retry.json()["success"] is True

    assert fake_db.users.increments == [30]
    assert len(fake_db.histories.docs) == 1


async def test_empty_event_id_falls_back_to_legacy_behavior(client, fake_db):
    """No eventId (e.g. older clients) must keep counting every request."""
    await _post(client, make_payload(duration=30))
    await _post(client, make_payload(duration=30))

    assert fake_db.users.increments == [30, 30]
    assert len(fake_db.histories.docs) == 2


async def test_concurrent_same_event_id_counts_once(client, fake_db):
    """Two racing flush-retries of the SAME batch must count it once."""
    results = await asyncio.gather(
        _post(client, make_payload(duration=30, event_id="evt-race")),
        _post(client, make_payload(duration=30, event_id="evt-race")),
    )
    assert all(r.status_code == 200 for r in results)
    assert all(r.json()["success"] is True for r in results)

    assert fake_db.users.increments == [30]
    assert len(fake_db.histories.docs) == 1


async def test_concurrent_distinct_event_ids_both_preserved(client, fake_db):
    """Different batches flushed concurrently must ALL land (no lost updates)."""
    await asyncio.gather(
        _post(client, make_payload(duration=30, event_id="evt-a")),
        _post(client, make_payload(duration=25, event_id="evt-b")),
        _post(client, make_payload(duration=45, event_id="evt-c")),
    )

    assert sorted(fake_db.users.increments) == [25, 30, 45]
    assert len(fake_db.histories.docs) == 3


async def test_oversized_listen_duration_rejected_before_any_write(client, fake_db):
    """Impossible durations (>300s) must be rejected without touching history
    or the total — the backend cap stays a hard wall."""
    resp = await _post(client, make_payload(duration=301, event_id="evt-big"))
    body = resp.json()
    assert body["success"] is False

    assert fake_db.users.increments == []
    assert fake_db.histories.docs == []

    ok = await _post(client, make_payload(duration=300, event_id="evt-max"))
    assert ok.json()["success"] is True
    assert fake_db.users.increments == [300]


async def test_event_id_is_cleaned_and_kept_short(client, fake_db):
    """A noisy/over-long idempotency key is sanitized, never stored verbatim."""
    noisy = "  evt\\1  2\t3 " + "x" * 200
    await _post(client, make_payload(duration=30, event_id=noisy))
    stored = fake_db.histories.docs[0]["eventId"]
    assert stored == stored.strip()          # leading/trailing whitespace removed
    assert len(stored) <= 64                 # capped by sanitize_text
    assert "\0" not in stored                # null bytes never stored