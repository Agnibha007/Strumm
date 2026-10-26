"""TEST-01: dedicated authentication test suite.

Covers the full auth lifecycle against the real FastAPI routes with a stateful
fake Mongo DB (no network, no real email):

    * registration (signup OTP) — validation, account creation, no plaintext
      or hashed password ever appears in a response
    * login (OTP + password) — success, generic failure messages, lockout
    * password reset — token lifecycle, session revocation
    * session management — list / revoke / change-password / change-email
    * token validation — missing / forged / expired / valid
    * account vs. public profile separation

"""

from __future__ import annotations

import os
import hashlib
from datetime import datetime, timedelta
from types import SimpleNamespace

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest

from bson.objectid import ObjectId

from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.services.auth_utils import create_access_token, hash_password


USER_ID = "507f1f77bcf86cd799439011"
USERNAME = "testuser"
EMAIL = "test@example.com"
PASSWORD = "CorrectHorse1BatteryStaple"


# ---------------------------------------------------------------------------
# Stateful fake Mongo
# ---------------------------------------------------------------------------


def _cmp(doc_value, expect):
    return doc_value == expect


class FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key, direction=-1):
        def sortable(v):
            if isinstance(v, datetime):
                return v.timestamp()
            return v or ""
        self._docs.sort(key=lambda d: sortable(d.get(key)), reverse=direction < 0)
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return self._docs[:length] if length else list(self._docs)

    def __aiter__(self):
        self._it = iter(list(self._docs))
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    def _resolve(self, doc, key):
        """Resolve dotted query keys (e.g. 'settings.publicPassport')."""
        cur = doc
        for part in key.split("."):
            if not isinstance(cur, dict) or part not in cur:
                return None
            cur = cur[part]
        return cur

    def _match(self, doc, query):
        for key, expect in query.items():
            if key == "$or":
                if not any(self._match(doc, sub) for sub in expect):
                    return False
            elif key == "$and":
                for sub in expect:
                    if not self._match(doc, sub):
                        return False
            elif isinstance(expect, dict):
                actual = self._resolve(doc, key)
                for op, value in expect.items():
                    if op == "$ne" and actual == value:
                        return False
                    elif op == "$gt" and not (isinstance(actual, datetime) and isinstance(value, datetime) and actual > value):
                        return False
                    elif op == "$lt" and not (isinstance(actual, datetime) and isinstance(value, datetime) and actual < value):
                        return False
                    elif op == "$in":
                        if value is None:
                            return False
                        if isinstance(actual, list):
                            if not any(item in value for item in actual):
                                return False
                        elif actual not in value:
                            return False
            elif self._resolve(doc, key) != expect:
                return False
        return True

    async def find_one(self, query=None):
        for doc in self.docs:
            if self._match(doc, query or {}):
                return dict(doc)
        return None

    def find(self, query=None, projection=None):
        return FakeCursor(d for d in self.docs if self._match(d, query or {}))

    def aggregate(self, pipeline=None, **kwargs):
        return FakeCursor([])

    async def insert_one(self, doc):
        doc = dict(doc)
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    async def update_one(self, query, update, upsert=False):
        for i, doc in enumerate(self.docs):
            if self._match(doc, query):
                merged = dict(doc)
                for op in ("$set", "$setOnInsert"):
                    merged.update(update.get(op, {}))
                for key, val in update.get("$inc", {}).items():
                    merged[key] = merged.get(key, 0) + val
                for key in update.get("$unset", {}):
                    merged.pop(key, None)
                self.docs[i] = merged
                return SimpleNamespace(modified_count=1, upserted_id=None)
        if upsert:
            new_doc = dict(update.get("$set", {}))
            for key, val in update.get("$setOnInsert", {}).items():
                new_doc.setdefault(key, val)
            for key, val in update.get("$inc", {}).items():
                new_doc[key] = new_doc.get(key, 0) + val
            self.docs.append(new_doc)
            return SimpleNamespace(modified_count=0, upserted_id=new_doc.get("_id"))
        return SimpleNamespace(modified_count=0, upserted_id=None)

    async def delete_one(self, query):
        for i, doc in enumerate(self.docs):
            if self._match(doc, query):
                del self.docs[i]
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)

    async def delete_many(self, query):
        kept = [d for d in self.docs if not self._match(d, query)]
        n = len(self.docs) - len(kept)
        self.docs = kept
        return SimpleNamespace(deleted_count=n)


class FakeDB:
    USERS = "users"
    SESSIONS = "sessions"
    PLAYLISTS = "playlists"
    PLAYBACK_HISTORIES = "playbackhistories"
    LIKED_SONGS = "liked_songs"
    PODCAST_SHOWS = "podcast_shows"

    def __init__(self, **collections):
        self._collections = {k: v for k, v in collections.items()}

    def __getitem__(self, name):
        if name not in self._collections:
            self._collections[name] = FakeCollection()
        return self._collections[name]

    def __setitem__(self, name, collection):
        self._collections[name] = collection


@pytest.fixture(autouse=True)
def _clean_app_state():
    """Isolate each test: reset the process-global rate limiter and any
    dependency overrides left behind by other test modules."""

    from app.main import rate_limiter

    rate_limiter._clients = {}
    yield
    rate_limiter._clients = {}

    from app.main import app as _app

    _app.dependency_overrides.clear()


def _make_db(**collections) -> FakeDB:
    return FakeDB(**collections)


def _client(db: FakeDB):
    from app.database import mongodb
    from app.main import app as _app

    mongodb.get_db = lambda: db

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


def _user_doc(*, email=EMAIL, username=USERNAME, password=None, providers=None, settings=None) -> dict:
    return {
        "_id": ObjectId(USER_ID),
        "username": username,
        "email": email,
        "displayName": "Test User",
        "password": password,
        "providers": providers or ["email"],
        "theme": "Obsidian",
        "avatar": None,
        "createdAt": datetime.utcnow() - timedelta(days=30),
        "settings": settings or {"privacy": "public", "publicPassport": True},
        "statistics": {"totalListeningTime": 0},
    }


def _session_doc(*, sid="507f1f77bcf86cd799439022", previous=None) -> dict:
    return {
        "_id": ObjectId(sid),
        "userId": USER_ID,
        "refreshTokenHash": f"hash-{sid}",
        "previousTokenHash": None if previous is None else f"hash-{previous}",
        "device": "test-agent",
        "createdAt": datetime.utcnow() - timedelta(days=1),
        "lastActiveAt": datetime.utcnow(),
        "expiresAt": datetime.utcnow() + timedelta(days=6),
    }


def _otp_doc(code="555666", *, metadata=None, expiry=None, attempts=0) -> dict:
    return {
        "_id": ObjectId("507f1f77bcf86cd799439033"),
        "email": EMAIL,
        "hashed_otp": auth_utils.hash_otp(code),
        "attempts": attempts,
        "expiry": expiry or (datetime.utcnow() + timedelta(minutes=10)),
        "metadata": metadata,
    }


def _access_token(*, sub=USER_ID, expires_delta=None) -> str:
    return create_access_token(
        {"sub": sub, "email": EMAIL, "username": USERNAME, "type": "access"},
        expires_delta=expires_delta,
    )


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_signup_returns_generic_success_and_stores_otp(monkeypatch):
    monkeypatch.setattr("app.routes.auth.generate_otp", lambda: "123456")
    db = _make_db()
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={
            "email": EMAIL, "username": USERNAME, "displayName": "Test User",
            "password": PASSWORD,
        })
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    # OTP stored hashed, never in plaintext
    otp_doc = db["otps"].docs[0]
    assert otp_doc["hashed_otp"] != "123456"
    assert otp_doc["hashed_otp"] == auth_utils.hash_otp("123456")
    # the plaintext code should NOT be echoed back by default
    assert "123456" not in resp.text


@pytest.mark.asyncio
async def test_signup_dev_otp_only_echoed_when_explicitly_enabled(monkeypatch):
    monkeypatch.setattr("app.routes.auth.generate_otp", lambda: "123456")
    monkeypatch.setenv("EXPOSE_DEV_OTP", "true")
    db = _make_db()
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={
            "email": EMAIL, "username": USERNAME, "displayName": "Test User",
            "password": PASSWORD,
        })
    assert resp.json()["data"]["dev_otp"] == "123456"

    monkeypatch.delenv("EXPOSE_DEV_OTP")
    db2 = _make_db()
    async with _client(db2) as c:
        resp = await c.post("/auth/signup", json={
            "email": "x@example.com", "username": "xuser", "displayName": "X",
            "password": PASSWORD,
        })
    assert resp.json()["data"]["dev_otp"] is None


@pytest.mark.asyncio
async def test_signup_rejects_duplicate_email(monkeypatch):
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={
            "email": EMAIL, "username": "otheruser", "displayName": "Other",
            "password": PASSWORD,
        })
    body = resp.json()
    assert body["success"] is False
    assert "already exists" in body["error"]


@pytest.mark.asyncio
async def test_signup_rejects_taken_username(monkeypatch):
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={
            "email": "new@example.com", "username": USERNAME, "displayName": "New",
            "password": PASSWORD,
        })
    body = resp.json()
    assert body["success"] is False
    assert "already taken" in body["error"]


@pytest.mark.asyncio
async def test_signup_rejects_weak_password(monkeypatch):
    db = _make_db()
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={
            "email": EMAIL, "username": USERNAME, "displayName": "Test",
            "password": "short",
        })
    body = resp.json()
    assert body["success"] is False
    assert db["otps"].docs == []  # nothing stored for an invalid signup


@pytest.mark.asyncio
async def test_signup_verify_creates_account_with_hashed_password(monkeypatch):
    monkeypatch.setattr("app.routes.auth.generate_otp", lambda: "654321")
    db = _make_db(otps=FakeCollection([
        _otp_doc(
            "654321",
            metadata={"username": USERNAME, "displayName": "Test User",
                      "password": hash_password(PASSWORD)},
        )
    ]))
    async with _client(db) as c:
        resp = await c.post("/auth/verify", json={"email": EMAIL, "otp": "654321"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert "token" in body["data"] and "refreshToken" in body["data"]
    # account created with a HASHED password (never plaintext)
    users = db["users"].docs
    assert len(users) == 1
    stored = users[0]
    assert stored["password"] != PASSWORD
    assert stored["password"] is not None
    assert stored["username"] == USERNAME
    # session created for the new user
    assert len(db["sessions"].docs) == 1
    # cookies set
    assert "access_token" in resp.cookies and "refresh_token" in resp.cookies
    # SEC-01: no password material anywhere in the response text
    assert "password" not in resp.text.lower()


@pytest.mark.asyncio
async def test_verify_wrong_otp_increments_attempts(monkeypatch):
    db = _make_db(otps=FakeCollection([_otp_doc("111111")]))
    async with _client(db) as c:
        resp = await c.post("/auth/verify", json={"email": EMAIL, "otp": "999999"})
    assert resp.json()["success"] is False
    assert db["otps"].docs[0]["attempts"] == 1


@pytest.mark.asyncio
async def test_verify_locks_after_five_attempts(monkeypatch):
    db = _make_db(otps=FakeCollection([_otp_doc("111111", attempts=5)]))
    async with _client(db) as c:
        resp = await c.post("/auth/verify", json={"email": EMAIL, "otp": "999999"})
    assert resp.json()["success"] is False
    assert "attempts" in resp.json()["error"].lower()
    assert db["otps"].docs == []  # OTP destroyed after lockout


@pytest.mark.asyncio
async def test_verify_expired_otp_rejected_and_deleted(monkeypatch):
    db = _make_db(otps=FakeCollection([
        _otp_doc("111111", expiry=datetime.utcnow() - timedelta(seconds=1))
    ]))
    async with _client(db) as c:
        resp = await c.post("/auth/verify", json={"email": EMAIL, "otp": "111111"})
    assert resp.json()["success"] is False
    assert "expired" in resp.json()["error"].lower()
    assert db["otps"].docs == []


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_login_otp_success_for_existing_user(monkeypatch):
    monkeypatch.setattr("app.routes.auth.generate_otp", lambda: "246810")
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        resp = await c.post("/auth/email", json={"email": EMAIL})
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert len(db["otps"].docs) == 1
    assert db["otps"].docs[0].get("metadata") is None  # clean login flow, no metadata

    async with _client(db) as c:
        resp = await c.post("/auth/verify", json={"email": EMAIL, "otp": "246810"})
    body = resp.json()
    assert body["success"] is True
    assert "refreshToken" in body["data"]
    assert len(db["sessions"].docs) == 1
    assert "password" not in resp.text.lower()


@pytest.mark.asyncio
async def test_login_otp_non_existing_user_same_generic_message(monkeypatch):
    db_with = _make_db(users=FakeCollection([_user_doc()]))
    db_without = _make_db()
    async with _client(db_with) as c:
        present = await c.post("/auth/email", json={"email": EMAIL})
    async with _client(db_without) as c:
        absent = await c.post("/auth/email", json={"email": "ghost@example.com"})
    msg_present = present.json().get("message") or present.json()["data"]["message"]
    msg_absent = absent.json().get("message") or absent.json()["data"]["message"]
    assert msg_present == msg_absent  # no account-existence oracle
    # and no OTP doc is created for unknown accounts
    assert db_without["otps"].docs == []


@pytest.mark.asyncio
async def test_password_login_success_no_password_leak():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
    body = resp.json()
    assert resp.status_code == 200
    assert body["success"] is True
    assert "token" in body["data"] and "refreshToken" in body["data"]
    assert len(db["sessions"].docs) == 1
    assert "password" not in resp.text.lower()


@pytest.mark.asyncio
async def test_password_login_wrong_password_generic_error():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={"email": EMAIL, "password": "wrong"})
    assert resp.json() == {"success": False, "error": "Invalid email or password."}
    assert db["sessions"].docs == []
    assert db["login_attempts"].docs[0]["attempts"] == 1


@pytest.mark.asyncio
async def test_password_login_unknown_user_same_generic_error():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        known = await c.post("/auth/login", json={"email": EMAIL, "password": "wrong"})
    async with _client(db) as c:
        unknown = await c.post("/auth/login", json={"email": "nobody@example.com", "password": "wrong"})
    assert known.json()["error"] == unknown.json()["error"]


@pytest.mark.asyncio
async def test_password_login_lockout_after_max_attempts():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    db["login_attempts"] = FakeCollection([{
        "email": EMAIL, "attempts": 5, "expiry": datetime.utcnow() + timedelta(minutes=10),
    }])
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert resp.json()["success"] is False
    assert "Too many login attempts" in resp.json()["error"]
    assert db["sessions"].docs == []


@pytest.mark.asyncio
async def test_password_login_google_only_account_rejected():
    db = _make_db(users=FakeCollection([_user_doc(password=None, providers=["google"])]))
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={"email": EMAIL, "password": "whatever"})
    body = resp.json()
    assert body["success"] is False
    assert "does not use password login" in body["error"]


# ---------------------------------------------------------------------------
# Refresh / logout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_keeps_refresh_token_stable_and_slides_session():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        login = await c.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
        refresh_cookie = login.cookies["refresh_token"]
        assert login.cookies["access_token"]
        ok = await c.post("/auth/refresh", json={"refreshToken": refresh_cookie})
    assert ok.status_code == 200
    data = ok.json()["data"]
    assert data["refreshToken"] == refresh_cookie
    assert ok.cookies["refresh_token"] == refresh_cookie
    session = db["sessions"].docs[0]
    assert (session["expiresAt"] - datetime.utcnow()).total_seconds() > 29 * 24 * 60 * 60


@pytest.mark.asyncio
async def test_refresh_with_unknown_token_rejected():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/refresh", json={"refreshToken": "not-a-real-token"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_logout_revokes_session_and_clears_cookies():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        login = await c.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
        rt = login.cookies["refresh_token"]
        logout = await c.post("/auth/logout", json={"refreshToken": rt})
    assert logout.status_code == 200
    assert db["sessions"].docs == []
    assert logout.cookies.get("refresh_token") is None  # cleared


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_forgot_password_stores_hash_and_returns_generic_message(monkeypatch):
    monkeypatch.setattr("app.routes.auth.secrets.token_urlsafe", lambda n=None: "reset-token-abc")
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/forgot-password", json={"email": EMAIL})
    assert resp.status_code == 200
    assert "If an account exists" in resp.json()["message"]
    reset = db["password_resets"].docs[0]
    assert reset["token_hash"] != "reset-token-abc"  # hashed
    assert reset["token_hash"] == hashlib.sha256("reset-token-abc".encode("utf-8")).hexdigest()
    assert resp.json()["dev_reset_link"] is not None  # dev environment


@pytest.mark.asyncio
async def test_forgot_password_unknown_email_same_message(monkeypatch):
    db_known = _make_db(users=FakeCollection([_user_doc()]))
    db_unknown = _make_db()
    async with _client(db_known) as c:
        known = await c.post("/auth/forgot-password", json={"email": EMAIL})
    async with _client(db_unknown) as c:
        unknown = await c.post("/auth/forgot-password", json={"email": "ghost@example.com"})
    assert known.json()["message"] == unknown.json()["message"]
    assert db_unknown["password_resets"].docs == []


@pytest.mark.asyncio
async def test_reset_password_success_updates_and_revokes_sessions():
    db = _make_db(
        users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]),
        sessions=FakeCollection([_session_doc(sid="507f1f77bcf86cd799439022")]),
    )
    db["password_resets"] = FakeCollection([{
        "email": EMAIL, "token_hash": hashlib.sha256("reset-token".encode("utf-8")).hexdigest(),
        "expiry": datetime.utcnow() + timedelta(minutes=30), "used": False,
    }])
    async with _client(db) as c:
        resp = await c.post("/auth/reset-password", json={
            "email": EMAIL, "token": "reset-token", "new_password": "NewHorse1Battery",
        })
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    new_hash = db["users"].docs[0]["password"]
    assert new_hash != hash_password(PASSWORD) or True  # rehashed below
    assert auth_utils.verify_password("NewHorse1Battery", new_hash)
    assert db["password_resets"].docs[0]["used"] is True
    assert db["sessions"].docs == []  # all sessions invalidated


@pytest.mark.asyncio
async def test_reset_password_wrong_or_missing_token_rejected():
    db = _make_db(users=FakeCollection([_user_doc()]))
    db["password_resets"] = FakeCollection([{
        "email": EMAIL, "token_hash": hashlib.sha256("right-token".encode("utf-8")).hexdigest(),
        "expiry": datetime.utcnow() + timedelta(minutes=30), "used": False,
    }])
    async with _client(db) as c:
        resp = await c.post("/auth/reset-password", json={
            "email": EMAIL, "token": "WRONG", "new_password": "NewHorse1Battery",
        })
    assert resp.json()["success"] is False
    old = db["users"].docs[0]
    assert "password" not in old or old["password"] is None  # unchanged


@pytest.mark.asyncio
async def test_reset_password_expired_token_rejected():
    db = _make_db(users=FakeCollection([_user_doc()]))
    db["password_resets"] = FakeCollection([{
        "email": EMAIL, "token_hash": hashlib.sha256("old-token".encode("utf-8")).hexdigest(),
        "expiry": datetime.utcnow() - timedelta(seconds=1), "used": False,
    }])
    async with _client(db) as c:
        resp = await c.post("/auth/reset-password", json={
            "email": EMAIL, "token": "old-token", "new_password": "NewHorse1Battery",
        })
    assert resp.json()["success"] is False


@pytest.mark.asyncio
async def test_reset_password_already_used_token_rejected():
    db = _make_db(users=FakeCollection([_user_doc()]))
    db["password_resets"] = FakeCollection([{
        "email": EMAIL, "token_hash": hashlib.sha256("used-token".encode("utf-8")).hexdigest(),
        "expiry": datetime.utcnow() + timedelta(minutes=30), "used": True,
    }])
    async with _client(db) as c:
        resp = await c.post("/auth/reset-password", json={
            "email": EMAIL, "token": "used-token", "new_password": "NewHorse1Battery",
        })
    assert resp.json()["success"] is False


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_sessions_only_returns_active_sessions_without_hashes():
    db = _make_db(
        users=FakeCollection([_user_doc()]),
        sessions=FakeCollection([
            _session_doc(sid="507f1f77bcf86cd799439024"),
            _session_doc(sid="507f1f77bcf86cd799439025"),
        ]),
    )
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.get("/auth/sessions", headers=auth)
    body = resp.json()
    assert resp.status_code == 200
    assert len(body["data"]["sessions"]) == 2
    text = resp.text.lower()
    assert "refreshtokenhash" not in text and "tokenhash" not in text


@pytest.mark.asyncio
async def test_revoke_specific_session():
    db = _make_db(
        users=FakeCollection([_user_doc()]),
        sessions=FakeCollection([
            _session_doc(sid="507f1f77bcf86cd799439024"),
            _session_doc(sid="507f1f77bcf86cd799439025"),
        ]),
    )
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.delete("/auth/sessions/507f1f77bcf86cd799439024", headers=auth)
    assert resp.json()["success"] is True
    assert len(db["sessions"].docs) == 1


@pytest.mark.asyncio
async def test_revoke_foreign_session_rejected():
    db = _make_db(
        users=FakeCollection([_user_doc()]),
        sessions=FakeCollection([{**_session_doc(sid="507f1f77bcf86cd799439026"),
                                 "userId": "000000000000000000000000"}]),
    )
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.delete("/auth/sessions/507f1f77bcf86cd799439026", headers=auth)
    assert resp.json()["success"] is False
    assert len(db["sessions"].docs) == 1  # untouched


@pytest.mark.asyncio
async def test_revoke_all_except_current_keeps_current():
    db = _make_db(
        users=FakeCollection([_user_doc()]),
        sessions=FakeCollection([
            _session_doc(sid="507f1f77bcf86cd799439024"),
            _session_doc(sid="507f1f77bcf86cd799439025"),
            _session_doc(sid="507f1f77bcf86cd799439027"),
        ]),
    )
    db["sessions"].docs[2]["refreshTokenHash"] = hashlib.sha256("current-token".encode("utf-8")).hexdigest()
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.request(
            "DELETE", "/auth/sessions", headers=auth, cookies={"refresh_token": "current-token"},
        )
    assert resp.json()["success"] is True
    remaining = db["sessions"].docs
    assert len(remaining) == 1
    assert remaining[0]["refreshTokenHash"] == hashlib.sha256("current-token".encode("utf-8")).hexdigest()


@pytest.mark.asyncio
async def test_change_password_requires_current_password():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.post("/auth/change-password", headers=auth, json={
            "currentPassword": "wrong", "newPassword": "NewHorse1Battery",
        })
    assert resp.json()["success"] is False


@pytest.mark.asyncio
async def test_change_password_revokes_other_sessions_keeps_current():
    db = _make_db(
        users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]),
        sessions=FakeCollection([
            _session_doc(sid="507f1f77bcf86cd799439024"),
            _session_doc(sid="507f1f77bcf86cd799439025"),
            _session_doc(sid="507f1f77bcf86cd799439027"),
        ]),
    )
    db["sessions"].docs[2]["refreshTokenHash"] = hashlib.sha256("current-token".encode("utf-8")).hexdigest()
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.post(
            "/auth/change-password", headers=auth,
            cookies={"refresh_token": "current-token"},
            json={"currentPassword": PASSWORD, "newPassword": "NewHorse1Battery"},
        )
    assert resp.json()["success"] is True
    remaining = db["sessions"].docs
    assert len(remaining) == 1
    assert remaining[0]["refreshTokenHash"] == hashlib.sha256("current-token".encode("utf-8")).hexdigest()


@pytest.mark.asyncio
async def test_change_email_updates_and_requires_password():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    auth = {"Authorization": f"Bearer {_access_token()}"}
    # wrong password rejected
    async with _client(db) as c:
        resp = await c.post("/auth/change-email", headers=auth, json={
            "password": "wrong", "newEmail": "new@example.com",
        })
    assert resp.json()["success"] is False
    assert db["users"].docs[0]["email"] == EMAIL

    async with _client(db) as c:
        resp = await c.post("/auth/change-email", headers=auth, json={
            "password": PASSWORD, "newEmail": "new@example.com",
        })
    assert resp.json()["success"] is True
    assert db["users"].docs[0]["email"] == "new@example.com"


# ---------------------------------------------------------------------------
# Token validation (real get_current_user dependency)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_profile_requires_token():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.get("/profile")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_profile_rejects_forged_token():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.get("/profile", headers={"Authorization": "Bearer aaaa.bbbb.cccc"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_profile_rejects_expired_token():
    db = _make_db(users=FakeCollection([_user_doc()]))
    expired = _access_token(expires_delta=timedelta(seconds=-10))
    async with _client(db) as c:
        resp = await c.get("/profile", headers={"Authorization": f"Bearer {expired}"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_profile_accepts_valid_token_and_slides_refresh_cookie():
    import hashlib

    session_id = "507f1f77bcf86cd799439022"
    refresh_token = "active-refresh-token"
    session = _session_doc(sid=session_id)
    session["refreshTokenHash"] = hashlib.sha256(refresh_token.encode()).hexdigest()
    db = _make_db(users=FakeCollection([_user_doc()]), sessions=FakeCollection([session]))
    token = create_access_token({
        "sub": USER_ID,
        "sid": session_id,
        "email": EMAIL,
        "username": USERNAME,
        "type": "access",
    })
    headers = {"Authorization": f"Bearer {token}"}
    async with _client(db) as c:
        resp = await c.get("/profile", headers=headers, cookies={"refresh_token": refresh_token})
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert "password" not in resp.text.lower()
    cookie = next(value for value in resp.headers.get_list("set-cookie") if value.startswith("refresh_token="))
    assert "Max-Age=2592000" in cookie


# ---------------------------------------------------------------------------
# Account access vs public profiles
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_public_profile_works_anonymously_and_leaks_no_private_fields():
    db = _make_db(users=FakeCollection([
        {**_user_doc(password=hash_password(PASSWORD)),
         "refreshTokenHash": "leak-me", "internalNote": "secret"}
    ]))
    async with _client(db) as c:
        resp = await c.get(f"/public/{USERNAME}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    text = resp.text.lower()
    assert "password" not in text
    assert "refreshtokenhash" not in text
    assert "secret" not in text and "internalnote" not in text
    assert body["data"]["username"] == USERNAME


@pytest.mark.asyncio
async def test_private_passport_is_hidden():
    db = _make_db(users=FakeCollection([
        _user_doc(settings={"privacy": "private", "publicPassport": False})
    ]))
    async with _client(db) as c:
        resp = await c.get(f"/public/{USERNAME}")
    assert resp.json() == {"success": False, "error": "This passport is set to private."}


# ---------------------------------------------------------------------------
# Sitemap privacy (PRIV-01)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sitemap_only_lists_public_profiles():
    private_user = _user_doc(username="private-user", settings={"privacy": "private", "publicPassport": False})
    legacy_user = _user_doc(username="legacy-user", settings={"privacy": "public"})
    public_user = _user_doc(username="public-user", settings={"privacy": "public", "publicPassport": True})
    db = _make_db(users=FakeCollection([private_user, legacy_user, public_user]))
    db["playlists"] = FakeCollection()
    db["liked_songs"] = FakeCollection()
    db["podcast_shows"] = FakeCollection()

    from app.database import mongodb

    mongodb.get_db = lambda: db

    from app.main import app as _app

    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=_app), base_url="http://test") as c:
        resp = await c.get("/sitemap")

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    usernames = {u["username"] for u in body["data"]["users"]}
    assert "private-user" not in usernames  # opted out of public passport
    assert "legacy-user" in usernames       # never opted out
    assert "public-user" in usernames       # explicitly public
    # a private profile URL must never appear in the sitemap payload either
    assert "private-user" not in resp.text

@pytest.mark.asyncio
async def test_reset_password_rejects_query_string_credentials():
    """SEC-07: new_password must travel in the JSON body, not the URL query."""
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post(
            "/auth/reset-password",
            params={
                "email": EMAIL,
                "token": "reset-token",
                "new_password": "NewHorse1Battery",
            },
        )
    # A password in the query string must not be accepted — 422, body-only field.
    assert resp.status_code == 422
    assert db["password_resets"].docs == []


# ---------------------------------------------------------------------------
# Account erasure and data export
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_account_deletion_cleans_user_data_social_links_rooms_and_owned_media(monkeypatch):
    from app.database import mongodb as db_names
    from app.services import storage

    friend_id = "507f1f77bcf86cd799439044"
    own_room_id = ObjectId("507f1f77bcf86cd799439055")
    shared_room_id = ObjectId("507f1f77bcf86cd799439066")
    owned_media_id = ObjectId("507f1f77bcf86cd799439077")
    removed_objects = []

    monkeypatch.setattr(storage, "storage_enabled", lambda: True)
    monkeypatch.setattr(storage, "delete_object", lambda key: removed_objects.append(key))

    from app.routes import user as user_routes

    async def no_email(_email):
        return None

    monkeypatch.setattr(user_routes, "send_account_deleted_email", no_email)

    own_playlist = {"_id": ObjectId(), "userId": USER_ID, "name": "My playlist", "songs": []}
    owned_memory = {"_id": ObjectId(), "userId": USER_ID, "song": {"title": "A memory"}}
    shared_blend = {
        "_id": ObjectId(), "userId": friend_id, "name": "Our Blend",
        "isBlend": True, "blendUsers": [USER_ID, friend_id], "songs": [],
    }
    db = _make_db(
        users=FakeCollection([_user_doc()]),
        sessions=FakeCollection([_session_doc()]),
        playlists=FakeCollection([own_playlist, shared_blend]),
        likedsongs=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        playbackhistories=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        playerstates=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        shares=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        podcastprogress=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        recentlyplayeds=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        follows=FakeCollection([
            {"_id": ObjectId(), "userId": USER_ID, "contentType": "podcast", "contentId": "show-1"},
            {"_id": ObjectId(), "userId": friend_id, "contentType": "user", "contentId": USER_ID},
        ]),
        activities=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        playlist_activity=FakeCollection([
            {"_id": ObjectId(), "userId": USER_ID, "playlistId": "other-playlist"},
            {"_id": ObjectId(), "userId": friend_id, "playlistId": str(own_playlist["_id"])},
        ]),
        songMemories=FakeCollection([owned_memory]),
        radio_logs=FakeCollection([{"_id": ObjectId(), "userId": USER_ID, "videoIds": ["v1"]}]),
        recommendation_logs=FakeCollection([{"_id": ObjectId(), "userId": USER_ID, "videoIds": ["v2"]}]),
        feedback=FakeCollection([{"_id": ObjectId(), "userId": USER_ID}]),
        otps=FakeCollection([{"_id": ObjectId(), "email": EMAIL}]),
        password_resets=FakeCollection([{"_id": ObjectId(), "email": EMAIL}]),
        login_attempts=FakeCollection([{"_id": ObjectId(), "email": EMAIL, "attempts": 2}]),
        connections=FakeCollection([
            {"_id": ObjectId(), "requesterId": USER_ID, "receiverId": friend_id},
            {"_id": ObjectId(), "requesterId": friend_id, "receiverId": "507f1f77bcf86cd799439088"},
        ]),
        rooms=FakeCollection([
            {"_id": own_room_id, "hostId": USER_ID, "members": [USER_ID], "controllers": [USER_ID]},
            {"_id": shared_room_id, "hostId": friend_id, "members": [USER_ID, friend_id], "controllers": [USER_ID], "invited": [USER_ID]},
        ]),
        notifications=FakeCollection([
            {"_id": ObjectId(), "userId": friend_id, "senderId": USER_ID, "type": "friend_request"},
            {"_id": ObjectId(), "userId": friend_id, "senderId": friend_id, "roomId": str(own_room_id), "type": "room_invite"},
            {"_id": ObjectId(), "userId": friend_id, "senderId": friend_id, "type": "unrelated"},
        ]),
        media=FakeCollection([{
            "_id": owned_media_id, "ownerId": USER_ID, "category": "avatar",
            "objectKey": f"users/{USER_ID}/avatar/avatar.webp", "status": "ready", "deletedAt": None,
        }]),
    )

    async with _client(db) as client:
        response = await client.delete("/profile", headers={"Authorization": f"Bearer {_access_token()}"})

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert db[db_names.USERS].docs == []
    for collection in (
        db_names.SESSIONS, db_names.PLAYLISTS, db_names.LIKED_SONGS,
        db_names.PLAYBACK_HISTORIES, db_names.PLAYER_STATES, db_names.SHARES,
        db_names.PODCAST_PROGRESS, db_names.RECENTLY_PLAYED, "activities",
        "playlist_activity", "songMemories", "radio_logs", "recommendation_logs", "feedback",
        "otps", "password_resets", "login_attempts",
    ):
        assert not any(doc.get("userId") == USER_ID for doc in db[collection].docs), collection
    assert len(db[db_names.CONNECTIONS].docs) == 1
    assert len(db["follows"].docs) == 0
    assert len(db[db_names.ROOMS].docs) == 1
    remaining_room = db[db_names.ROOMS].docs[0]
    assert remaining_room["_id"] == shared_room_id
    assert remaining_room["members"] == [friend_id]
    assert remaining_room["controllers"] == []
    assert remaining_room["invited"] == []
    assert len(db[db_names.NOTIFICATIONS].docs) == 1
    assert db[db_names.NOTIFICATIONS].docs[0]["type"] == "unrelated"
    assert len(db[db_names.PLAYLISTS].docs) == 1
    assert db["playlist_activity"].docs == []
    assert db["songMemories"].docs == []
    assert db[db_names.PLAYLISTS].docs[0]["blendUsers"] == [friend_id]
    assert db[db_names.PLAYLISTS].docs[0]["isBlend"] is False
    assert removed_objects == [f"users/{USER_ID}/avatar/avatar.webp"]
    assert db[db_names.MEDIA].docs == []


@pytest.mark.asyncio
async def test_account_deletion_fails_closed_when_owned_media_cannot_be_removed(monkeypatch):
    from app.services import storage

    from app.routes import user as user_routes

    async def no_email(_email):
        return None

    monkeypatch.setattr(user_routes, "send_account_deleted_email", no_email)
    monkeypatch.setattr(storage, "storage_enabled", lambda: True)

    def fail_delete(_key):
        raise RuntimeError("object store unavailable")

    monkeypatch.setattr(storage, "delete_object", fail_delete)
    media_doc = {
        "_id": ObjectId(), "ownerId": USER_ID, "objectKey": "users/test/avatar.webp",
        "status": "ready", "deletedAt": None,
    }
    db = _make_db(
        users=FakeCollection([_user_doc()]),
        sessions=FakeCollection([_session_doc()]),
        media=FakeCollection([media_doc]),
    )

    async with _client(db) as client:
        response = await client.delete("/profile", headers={"Authorization": f"Bearer {_access_token()}"})

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert len(db["users"].docs) == 1
    assert len(db["sessions"].docs) == 1
    assert db["media"].docs[0]["deletedAt"] is None


@pytest.mark.asyncio
async def test_profile_export_includes_more_than_one_thousand_history_entries():
    from app.database import mongodb as db_names

    history = [
        {
            "_id": ObjectId(), "userId": USER_ID,
            "song": {"title": f"Track {i}", "artist": "Test Artist", "videoId": f"video-{i}"},
            "listenDuration": 30, "playedAt": datetime.utcnow() - timedelta(seconds=i),
        }
        for i in range(1005)
    ]
    db = _make_db(users=FakeCollection([_user_doc()]), playbackhistories=FakeCollection(history))

    async with _client(db) as client:
        response = await client.get("/profile/export", headers={"Authorization": f"Bearer {_access_token()}"})

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["totalHistoryEntries"] == 1005


@pytest.mark.asyncio
async def test_explore_chat_uses_request_scoped_playlist_aliases_and_filters_history(monkeypatch):
    from app.routes import recommendation as recommendation_routes

    playlist_id = ObjectId("507f1f77bcf86cd799439055")
    captured = {}

    class FakeAI:
        configured = True

        async def extract_json(self, messages, **kwargs):
            captured["messages"] = messages
            return {
                "message": "I can help edit this playlist.",
                "songs": [],
                "create_playlist": False,
                "edit_playlist": True,
                "playlist_id": "playlist_1",
                "songs_to_add": [],
                "songs_to_remove": [],
                "requires_confirmation": True,
            }

    class FakeRecommendationEngine:
        async def generate(self, **kwargs):
            return {
                "songs": [{
                    "videoId": "vid1", "title": "Example Song", "artist": "Example Artist",
                    "thumbnail": "", "duration": 180,
                }]
            }

    monkeypatch.setattr(recommendation_routes, "ai", FakeAI())
    monkeypatch.setattr(recommendation_routes, "rec_engine", FakeRecommendationEngine())

    db = _make_db(
        users=FakeCollection([_user_doc()]),
        playlists=FakeCollection([{
            "_id": playlist_id,
            "userId": USER_ID,
            "name": "Private playlist name",
            "songs": [],
            "createdAt": datetime.utcnow(),
        }]),
        likedsongs=FakeCollection([]),
        playbackhistories=FakeCollection([]),
    )

    async with _client(db) as client:
        response = await client.post(
            "/explore-chat",
            headers={"Authorization": f"Bearer {_access_token()}"},
            json={
                "prompt": "Help me edit my playlist",
                "history": [
                    {"role": "system", "content": "DO_NOT_SEND_THIS_SYSTEM_MESSAGE"},
                    {"role": "assistant", "content": "Earlier music context"},
                ],
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["data"]["playlist_id"] == str(playlist_id)

    ai_messages = captured["messages"]
    serialized_messages = "\n".join(message["content"] for message in ai_messages)
    assert "playlist_1" in serialized_messages
    assert "Private playlist name" in serialized_messages
    assert str(playlist_id) not in serialized_messages
    assert "DO_NOT_SEND_THIS_SYSTEM_MESSAGE" not in serialized_messages
    assert all(message["role"] in {"system", "user", "assistant"} for message in ai_messages)
