"""OPS-02: security-header consistency across every response path.

Normal responses, rate-limited responses, unhandled exceptions, HTTPException
responses and validation errors must all carry the same security headers.
"""

from __future__ import annotations

import os
import time
from collections import OrderedDict

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest

from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.main import _security_headers
from tests.test_auth_flow import _make_db, _client, FakeCollection

EXPECTED = set(_security_headers())


@pytest.fixture(autouse=True)
def _clean_app_state():
    from app.main import rate_limiter

    rate_limiter._clients = {}
    yield
    rate_limiter._clients = {}

    from app.main import app as _app

    _app.dependency_overrides.clear()


def _assert_has_security_headers(resp):
    for header in EXPECTED:
        assert header in resp.headers, f"missing {header} on {resp.status_code}"


@pytest.mark.asyncio
async def test_normal_response_has_security_headers():
    db = _make_db(users=FakeCollection())
    async with _client(db) as c:
        resp = await c.get("/health")
    assert resp.status_code == 200
    _assert_has_security_headers(resp)


@pytest.mark.asyncio
async def test_rate_limited_response_has_security_headers():
    from app.main import rate_limiter

    # Pre-seed the limiter so a single /auth/login request is already over quota.
    rate_limiter._clients["127.0.0.1"] = OrderedDict({
        "5/60": [time.time() - 1] * 5,
    })
    db = _make_db(users=FakeCollection())
    async with _client(db) as c:
        resp = await c.post("/auth/login", json={"email": "test@example.com", "password": "WrongPass1!"})
    assert resp.status_code == 429
    _assert_has_security_headers(resp)


@pytest.mark.asyncio
async def test_validation_error_response_has_security_headers():
    db = _make_db(users=FakeCollection())
    async with _client(db) as c:
        resp = await c.post("/auth/signup", json={})
    assert resp.status_code == 422
    _assert_has_security_headers(resp)


@pytest.mark.asyncio
async def test_http_exception_response_has_security_headers():
    db = _make_db(users=FakeCollection())
    async with _client(db) as c:
        resp = await c.get("/audio-proxy", params={"url": "http://127.0.0.1/a.mp4"})
    assert resp.status_code == 400
    _assert_has_security_headers(resp)


@pytest.mark.asyncio
async def test_global_exception_response_has_security_headers():
    from starlette.requests import Request
    from app.main import global_exception_handler

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/boom",
        "headers": [],
        "server": ("test", 80),
    }
    resp = await global_exception_handler(Request(scope), RuntimeError("boom"))
    assert resp.status_code == 500
    _assert_has_security_headers(resp)