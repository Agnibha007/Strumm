"""Refresh-session idle-expiry and legacy token-reuse regression tests."""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from types import SimpleNamespace

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest

from bson.objectid import ObjectId

# Pin the secret regardless of module-import order across the test run.
from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.routes.auth import hash_refresh_token


@pytest.fixture(autouse=True)
def _isolate_rate_limiter():
    """The in-memory per-IP/endpoint rate limiter is process-global; reset it
    per test so auth routes (limit 60/min in production) never 429 a test run
    just because other tests used the same 127.0.0.1."""

    from app.main import rate_limiter

    rate_limiter._clients = {}
    yield
    rate_limiter._clients = {}


def _uid():
    return ObjectId("507f1f77bcf86cd799439011")


def _sid(seed: int = 1):
    return ObjectId(f"507f1f77bcf86cd7994390{seed:02d}")


class FakeCollection:
    """Minimal stateful stand-in for a Mongo collection supporting the exact
    operations the refresh flow performs (find_one / update_one / delete_one /
    delete_many with simple equality + $or filters and $set updates)."""

    def __init__(self, docs, on_update_pre=None):
        self.docs = list(docs)
        # Optional hook that fires *inside* update_one before the $set applies.
        # Lets a test simulate a concurrent rotation racing the CAS filter.
        self._on_update_pre = on_update_pre

    def _match(self, doc, query):
        for key, expect in query.items():
            if key == "$or":
                if not any(self._match(doc, sub) for sub in expect):
                    return False
            elif key == "_id":
                if str(doc.get(key)) != str(expect):
                    return False
            else:
                if doc.get(key) != expect:
                    return False
        return True

    async def find_one(self, query=None):
        for doc in self.docs:
            if self._match(doc, query or {}):
                return dict(doc)
        return None

    async def insert_one(self, doc):
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=doc.get("_id"))

    async def update_one(self, query, update):
        if self._on_update_pre:
            self._on_update_pre(self.docs)
        for i, doc in enumerate(self.docs):
            if self._match(doc, query):
                merged = dict(doc)
                merged.update(update.get("$set", {}))
                self.docs[i] = merged
                return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)

    async def delete_one(self, query):
        for i, doc in enumerate(self.docs):
            if self._match(doc, query):
                del self.docs[i]
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)

    async def delete_many(self, query):
        for i in range(len(self.docs) - 1, -1, -1):
            if self._match(self.docs[i], query):
                del self.docs[i]
        return SimpleNamespace(deleted_count=0)


def _session_doc(current_token_hash: str, *, previous_token_hash: str | None = None) -> dict:
    doc = {
        "_id": _sid(),
        "userId": str(_uid()),
        "refreshTokenHash": current_token_hash,
        "device": "test-agent",
        "createdAt": datetime.utcnow() - timedelta(days=1),
        "lastActiveAt": datetime.utcnow(),
        "expiresAt": datetime.utcnow() + timedelta(days=6),
    }
    if previous_token_hash:
        doc["previousTokenHash"] = previous_token_hash
    return doc


def _user_doc() -> dict:
    return {
        "_id": _uid(),
        "username": "testuser",
        "email": "test@example.com",
        "displayName": "Test User",
        "createdAt": datetime.utcnow(),
        "settings": {"privacy": "public"},
    }


def _make_db(sessions: FakeCollection, users: FakeCollection):
    from unittest.mock import MagicMock

    db = MagicMock()
    db.SESSIONS = "sessions"
    db.USERS = "users"

    def _getitem(name):
        return sessions if name == db.SESSIONS else users if name == db.USERS else MagicMock()

    db.__getitem__.side_effect = _getitem
    return db


def _client(db):
    from app.database import mongodb
    from app.main import app as _app

    mongodb.get_db = lambda: db

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


@pytest.mark.asyncio
async def test_refresh_keeps_token_stable_and_extends_idle_expiry():
    token_a = "a" * 64
    sessions = FakeCollection([_session_doc(hash_refresh_token(token_a))])
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    async with _client(db) as c:
        resp = await c.post("/auth/refresh", json={"refreshToken": token_a})

    assert resp.status_code == 200
    data = resp.json()["data"]
    body_new = data["refreshToken"]
    assert body_new == token_a
    assert resp.cookies["refresh_token"] == token_a

    stored = sessions.docs[0]
    assert stored["refreshTokenHash"] == hash_refresh_token(token_a)
    assert stored.get("previousTokenHash") is None
    assert (stored["expiresAt"] - datetime.utcnow()).total_seconds() > 29 * 24 * 60 * 60


@pytest.mark.asyncio
async def test_authenticated_activity_slides_session_idle_expiry():
    from app.database import mongodb
    from app.routes.dependencies import update_last_active

    session = _session_doc(hash_refresh_token("active-token"))
    session["expiresAt"] = datetime.utcnow() + timedelta(days=1)
    sessions = FakeCollection([session])
    db = _make_db(sessions, FakeCollection([_user_doc()]))
    mongodb.get_db = lambda: db

    await update_last_active(str(_uid()), str(session["_id"]))

    assert (sessions.docs[0]["expiresAt"] - datetime.utcnow()).total_seconds() > 29 * 24 * 60 * 60


@pytest.mark.asyncio
async def test_stale_legacy_refresh_token_does_not_revoke_active_session():
    token_a = "a" * 64
    token_b = "b" * 64
    sessions = FakeCollection([
        _session_doc(
            hash_refresh_token(token_b),
            previous_token_hash=hash_refresh_token(token_a),
        )
    ])
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    async with _client(db) as c:
        stale = await c.post("/auth/refresh", json={"refreshToken": token_a})
        current = await c.post("/auth/refresh", json={"refreshToken": token_b})

    assert stale.status_code == 401
    assert current.status_code == 200
    assert len(sessions.docs) == 1
    assert sessions.docs[0]["refreshTokenHash"] == hash_refresh_token(token_b)


@pytest.mark.asyncio
async def test_current_body_refresh_token_wins_over_stale_cookie():
    token_a = "a" * 64
    token_b = "b" * 64
    sessions = FakeCollection([
        _session_doc(
            hash_refresh_token(token_b),
            previous_token_hash=hash_refresh_token(token_a),
        )
    ])
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    async with _client(db) as c:
        resp = await c.post(
            "/auth/refresh",
            json={"refreshToken": token_b},
            cookies={"refresh_token": token_a},
        )

    assert resp.status_code == 200
    assert resp.json()["data"]["refreshToken"] == token_b
    assert resp.cookies["refresh_token"] == token_b
    assert len(sessions.docs) == 1


@pytest.mark.asyncio
async def test_refresh_race_rejects_without_revoking_session_family():
    token_a = "a" * 64  # presented AND current
    sessions = FakeCollection(
        [_session_doc(hash_refresh_token(token_a))],
        # Simulate a concurrent legacy refresh changing the stored token hash.
        on_update_pre=lambda docs: docs[0].update(
            {"refreshTokenHash": hash_refresh_token("b" * 64),
             "previousTokenHash": hash_refresh_token(token_a)}
        ),
    )
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    async with _client(db) as c:
        resp = await c.post("/auth/refresh", json={"refreshToken": token_a})

    assert resp.status_code == 401
    assert len(sessions.docs) == 1


@pytest.mark.asyncio
async def test_rotation_race_without_previous_match_just_rejects():
    token_a = "a" * 64  # presented AND current
    sessions = FakeCollection(
        [_session_doc(hash_refresh_token(token_a))],
        # Another legacy request advanced the stored token hash twice.
        on_update_pre=lambda docs: docs[0].update(
            {"refreshTokenHash": hash_refresh_token("c" * 64),
             "previousTokenHash": hash_refresh_token("b" * 64)}
        ),
    )
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    async with _client(db) as c:
        resp = await c.post("/auth/refresh", json={"refreshToken": token_a})

    assert resp.status_code == 401
    assert len(sessions.docs) == 1  # session survives; nothing to revoke


@pytest.mark.asyncio
async def test_logout_accepts_previous_rotated_token():
    token_a = "a" * 64
    token_b = "b" * 64
    sessions = FakeCollection([
        _session_doc(
            hash_refresh_token(token_b),
            previous_token_hash=hash_refresh_token(token_a),
        )
    ])
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    # Logging out with the previous (already-rotated) token still clears the
    # session: the user legitimately holds it from an earlier rotation.
    async with _client(db) as c:
        resp = await c.post("/auth/logout", json={"refreshToken": token_a})

    assert resp.status_code == 200
    assert sessions.docs == []


@pytest.mark.asyncio
async def test_expired_session_is_rejected_and_deleted():
    token_a = "a" * 64
    doc = _session_doc(hash_refresh_token(token_a))
    doc["expiresAt"] = datetime.utcnow() - timedelta(minutes=1)
    sessions = FakeCollection([doc])
    db = _make_db(sessions, FakeCollection([_user_doc()]))

    async with _client(db) as c:
        resp = await c.post("/auth/refresh", json={"refreshToken": token_a})

    assert resp.status_code == 401
    assert sessions.docs == []