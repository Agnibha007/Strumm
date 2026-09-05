"""SEC-05: cookie/JWT lifetime coherence regression tests.

The access-token cookie's Max-Age must equal the access JWT's lifetime and the
refresh cookie's Max-Age must equal the sliding session's 7-day expiry.  A
browser should never drop a cookie before the matching token is invalid, or
keep a cookie after the token/session it mirrors has ended.
"""

from __future__ import annotations

import os
import hashlib
from datetime import datetime, timedelta

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest
from bson.objectid import ObjectId

from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.services.auth_utils import ACCESS_TOKEN_EXPIRE, decode_access_token, hash_password
from tests.test_auth_flow import (
    PASSWORD,
    _client,
    _make_db,
    _user_doc,
    FakeCollection,
)

ACCESS_COOKIE_MAX_AGE = int(ACCESS_TOKEN_EXPIRE.total_seconds())
REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60
USER_ID = "507f1f77bcf86cd799439011"


@pytest.fixture(autouse=True)
def _clean_app_state():
    from app.main import rate_limiter

    rate_limiter._clients = {}
    yield
    rate_limiter._clients = {}

    from app.main import app as _app

    _app.dependency_overrides.clear()


def _cookie_attrs(set_cookie_value: str) -> dict:
    parts = set_cookie_value.split("; ")
    name, _, value = parts[0].partition("=")
    attrs = {"name": name, "value": value}
    for part in parts[1:]:
        key, sep, val = part.partition("=")
        attrs[key.lower()] = val if sep else True
    return attrs


def _cookies_by_name(resp) -> dict:
    return {
        _cookie_attrs(sc)["name"]: _cookie_attrs(sc)
        for sc in resp.headers.get_list("set-cookie")
    }


@pytest.mark.asyncio
async def test_login_cookies_match_token_lifetimes():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={"email": "test@example.com", "password": PASSWORD})
    assert resp.json()["success"] is True

    cookies = _cookies_by_name(resp)
    access, refresh = cookies["access_token"], cookies["refresh_token"]

    # Access cookie mirrors the 1-hour access JWT.
    assert int(access["max-age"]) == ACCESS_COOKIE_MAX_AGE == 3600
    assert "httponly" in access

    # Refresh cookie mirrors the sliding 7-day session.
    assert int(refresh["max-age"]) == REFRESH_COOKIE_MAX_AGE
    assert "httponly" in refresh

    # The JWT itself must not outlive the cookie that carries it.
    token = resp.json()["data"]["token"]
    payload = decode_access_token(token)
    assert payload is not None
    import time
    ttl = payload["exp"] - time.time()
    assert 0 < ttl <= ACCESS_COOKIE_MAX_AGE + 60


@pytest.mark.asyncio
async def test_refresh_reissues_coherent_access_cookie():
    db = _make_db(users=FakeCollection([_user_doc(password=hash_password(PASSWORD))]))
    db["sessions"] = FakeCollection([
        {
            "_id": ObjectId("507f1f77bcf86cd799439022"),
            "userId": USER_ID,
            "refreshTokenHash": hashlib.sha256("refresh-token-value".encode("utf-8")).hexdigest(),
            "device": "test-agent",
            "createdAt": datetime.utcnow(),
            "lastActiveAt": datetime.utcnow(),
            "expiresAt": datetime.utcnow() + timedelta(days=6),
        }
    ])

    async with _client(db) as c:
        resp = await c.post("/auth/refresh", cookies={"refresh_token": "refresh-token-value"})
    assert resp.json()["success"] is True

    access = _cookies_by_name(resp)["access_token"]
    assert int(access["max-age"]) == ACCESS_COOKIE_MAX_AGE

    # The rotated session was extended by a full sliding window (7 days).
    session = db["sessions"].docs[0]
    ttl_seconds = (session["expiresAt"] - datetime.utcnow()).total_seconds()
    assert ttl_seconds > 6 * 24 * 60 * 60  # ~7 days forward, not shrinking