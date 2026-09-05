"""SEC-06: OTP HMAC-pepper storage regression tests.

Stored OTP digests must be HMAC-SHA256 keyed with a server-side pepper, never a
bare SHA-256.  A leak of the ``otps`` collection must not allow offline
brute-force of the 6-digit OTP space.
"""

from __future__ import annotations

import hashlib
import hmac
import os

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest

from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]


def test_hash_otp_returns_hex_digest():
    assert len(auth_utils.hash_otp("123456")) == 64
    assert all(c in "0123456789abcdef" for c in auth_utils.hash_otp("123456"))


def test_hash_otp_is_deterministic_for_same_input():
    assert auth_utils.hash_otp("123456") == auth_utils.hash_otp("123456")


def test_hash_otp_is_not_bare_sha256():
    """The digest must NOT equal plain sha256(otp) — it must be keyed."""
    otp = "123456"
    stored = auth_utils.hash_otp(otp)
    assert stored != hashlib.sha256(otp.encode("utf-8")).hexdigest()
    assert stored != hashlib.sha256(otp.encode("utf-8")).hexdigest().upper()


def test_hash_otp_matches_expected_hmac_construction():
    pepper = hmac.new(
        auth_utils.OTP_PEPPER_CONTEXT,
        auth_utils.get_jwt_secret().encode("utf-8"),
        hashlib.sha256,
    ).digest()
    expected = hmac.new(pepper, b"987654", hashlib.sha256).hexdigest()
    assert auth_utils.hash_otp("987654") == expected


def test_hash_otp_changes_when_secret_changes():
    first = auth_utils.hash_otp("111111")
    try:
        auth_utils.JWT_SECRET = "a-different-secret-0123456789abcdef0123456789abcdef"
        second = auth_utils.hash_otp("111111")
    finally:
        auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]
    assert first != second


def test_otp_verify_endpoint_works_with_peppered_digests():
    """Full OTP flow: login-OTP stored as a peppered digest, verify matches it."""
    import asyncio
    from datetime import datetime, timedelta

    from tests.test_auth_flow import _make_db, _client, _user_doc, FakeCollection

    db = _make_db(users=FakeCollection([_user_doc()]))
    db["otps"] = FakeCollection([{
        "email": "test@example.com",
        "hashed_otp": auth_utils.hash_otp("555666"),
        "attempts": 0,
        "expiry": datetime.utcnow() + timedelta(minutes=10),
    }])

    async def go():
        async with _client(db) as c:
            resp = await c.post(
                "/auth/verify",
                json={"email": "test@example.com", "otp": "555666"},
            )
        return resp.json()

    body = asyncio.run(go())
    assert body["success"] is True
    assert body["data"]["token"] is not None