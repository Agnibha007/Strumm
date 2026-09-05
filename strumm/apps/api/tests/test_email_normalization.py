"""SEC-03: email normalization / enumeration regression tests.

Every auth boundary must funnel email through ``normalize_email`` so a single
mailbox always maps to one canonical key regardless of case or whitespace
variants, and so existence is never leaked through variant lookups on
``/send-otp`` / ``/forgot-password`` (which stay generic for unknown emails).
"""

from __future__ import annotations

import os
import hashlib
from datetime import datetime, timedelta

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest

from app.services import auth_utils, security

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.services.auth_utils import hash_password
from tests.test_auth_flow import (
    EMAIL,
    PASSWORD,
    USERNAME,
    _access_token,
    _client,
    _make_db,
    _user_doc,
    FakeCollection,
)


@pytest.fixture(autouse=True)
def _clean_app_state():
    from app.main import rate_limiter

    rate_limiter._clients = {}
    yield
    rate_limiter._clients = {}

    from app.main import app as _app

    _app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# normalize_email unit behaviour
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("User@Example.COM", "user@example.com"),
        ("  user@example.com  ", "user@example.com"),
        ("u s e r@example.com", "user@example.com"),
        ("USER@EXAMPLE.COM", "user@example.com"),
        ("Mix.ed.Case+tag@Sub.Example.org", "mix.ed.case+tag@sub.example.org"),
    ],
)
def test_normalize_email_canonicalizes(raw, expected):
    assert security.normalize_email(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "no-at-sign",
        "@example.com",
        "user@",
        "user@nodot",
        "x" * 300 + "@example.com",
    ],
)
def test_normalize_email_rejects_invalid(raw):
    with pytest.raises(ValueError):
        security.normalize_email(raw)


# ---------------------------------------------------------------------------
# End-to-end: variant emails resolve to the same canonical account
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_signup_variant_email_rejected_as_duplicate():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={
            "email": "  Test@Example.COM  ",
            "username": "otheruser",
            "displayName": "Other",
            "password": PASSWORD,
        })
    body = resp.json()
    assert body["success"] is False
    assert "already exists" in body["error"]
    # no OTP document was created for the variant key
    assert db["otps"].docs == []


@pytest.mark.asyncio
async def test_login_variant_email_succeeds_against_canonical_account():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={
            "email": "  Test@Example.COM  ",
            "password": PASSWORD,
        })
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_send_otp_variant_email_uses_canonical_key():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/email", json={"email": "  Test@Example.COM  "})
    assert resp.json()["success"] is True
    assert resp.json()["data"]["message"] == (
        "If an account exists with this email, a verification code has been sent."
    )
    assert db["otps"].docs[0]["email"] == EMAIL


@pytest.mark.asyncio
async def test_forgot_password_variant_email_uses_canonical_key():
    from tests.test_auth_flow import EMAIL as canonical

    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/forgot-password", json={"email": "  Test@Example.COM  "})
    assert resp.json()["success"] is True
    reset_docs = db["password_resets"].docs
    assert len(reset_docs) == 1
    assert reset_docs[0]["email"] == canonical


@pytest.mark.asyncio
async def test_reset_password_with_variant_email_matches_canonical_token():
    reset_email = EMAIL
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    db["password_resets"] = FakeCollection([{
        "email": reset_email,
        "token_hash": hashlib.sha256("reset-token-abc".encode("utf-8")).hexdigest(),
        "expiry": datetime.utcnow() + timedelta(minutes=30),
        "used": False,
    }])
    async with _client(db) as c:
        resp = await c.post(
            "/auth/reset-password",
            json={
                "email": "  Test@Example.COM  ",
                "token": "reset-token-abc",
                "new_password": "NewHorse1Battery",
            },
        )
    assert resp.json()["success"] is True
    assert db["password_resets"].docs[0]["used"] is True


@pytest.mark.asyncio
async def test_change_email_stores_normalized_value():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    auth = {"Authorization": f"Bearer {_access_token()}"}
    async with _client(db) as c:
        resp = await c.post("/auth/change-email", headers=auth, json={
            "password": PASSWORD,
            "newEmail": "  New.User@Example.COM  ",
        })
    assert resp.json()["success"] is True
    assert db["users"].docs[0]["email"] == "new.user@example.com"


# ---------------------------------------------------------------------------
# Non-enumeration: unknown emails still get the generic message
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_otp_unknown_email_not_revealed():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/email", json={"email": "nobody@nonexistent.example"})
    body = resp.json()
    assert body == {
        "success": True,
        "message": "If an account exists with this email, a verification code has been sent.",
    }


@pytest.mark.asyncio
async def test_forgot_password_unknown_email_not_revealed():
    db = _make_db(users=FakeCollection([_user_doc()]))
    async with _client(db) as c:
        resp = await c.post("/auth/forgot-password", json={"email": "nobody@nonexistent.example"})
    assert resp.json() == {
        "success": True,
        "message": "If an account exists with this email, a password reset link has been sent.",
    }