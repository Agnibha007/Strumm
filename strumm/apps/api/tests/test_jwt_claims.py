"""SEC-04: JWT issuer/audience/type hardening regression tests.

Tokens minted by ``create_access_token`` must carry ``iss``, ``aud`` and
``type`` claims, and ``decode_access_token`` must reject any token that lacks
the expected claims or uses a different stage/context.  Google social logins
must also pin the expected issuer.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import jwt
import pytest

from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.services.auth_utils import JWT_AUDIENCE, JWT_ISSUER, create_access_token, decode_access_token

_CREATE_SECRET = auth_utils.get_jwt_secret()


def _raw_token(token):
    """Decode without validation for claim inspection."""
    return jwt.decode(
        token,
        _CREATE_SECRET,
        algorithms=["HS256"],
        options={"verify_signature": False},
    )


def _encode(payload):
    return jwt.encode(payload, _CREATE_SECRET, algorithm="HS256")


def _valid_payload(**overrides):
    payload = {
        "sub": "507f1f77bcf86cd799439011",
        "email": "test@example.com",
        "username": "testuser",
        "type": "access",
        "exp": datetime.utcnow() + timedelta(minutes=30),
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# minting
# ---------------------------------------------------------------------------


def test_minted_token_carries_required_claims():
    token = create_access_token({"sub": "u1", "email": "a@b.com", "username": "a"})
    claims = _raw_token(token)
    assert claims["iss"] == JWT_ISSUER
    assert claims["aud"] == JWT_AUDIENCE
    assert claims["type"] == "access"
    assert claims["sub"] == "u1"
    assert "exp" in claims


def test_minted_token_decodes():
    token = create_access_token({"sub": "u1", "email": "a@b.com", "username": "a"})
    payload = decode_access_token(token)
    assert payload is not None
    assert payload["sub"] == "u1"


# ---------------------------------------------------------------------------
# rejection
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "mutate,reason",
    [
        ({"iss": "evil-stage"}, "wrong issuer"),
        ({"aud": "other-app"}, "wrong audience"),
        ({"type": "refresh"}, "not an access token"),
        ({"type": None}, "type claim missing entirely"),
    ],
)
def test_decode_rejects_invalid_claim(mutate, reason):
    payload = _valid_payload(**{k: v for k, v in mutate.items() if v is not None})
    if mutate.get("type") is None:
        payload.pop("type")
    token = _encode(payload)
    assert decode_access_token(token) is None, reason


def test_decode_rejects_missing_claims():
    token = _encode({"sub": "u1", "exp": datetime.utcnow() + timedelta(minutes=5)})
    assert decode_access_token(token) is None


def test_decode_rejects_forged_signature():
    other = jwt.encode(_valid_payload(), "attacker-secret-9876543210abcdef", algorithm="HS256")
    assert decode_access_token(other) is None


def test_decode_rejects_expired_token():
    token = create_access_token(
        {"sub": "u1", "email": "a@b.com", "username": "a"},
        expires_delta=timedelta(seconds=-1),
    )
    assert decode_access_token(token) is None


# ---------------------------------------------------------------------------
# Google social-login issuer pinning
# ---------------------------------------------------------------------------


class _StubResp:
    def __init__(self, status_code, json_data):
        self.status_code = status_code
        self._json = json_data

    def json(self):
        return self._json


def _setup_google(monkeypatch, *, iss, resp_status=200):
    from app.routes import auth

    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-123.apps.googleusercontent.com")

    class _FakeClient:
        async def get(self, *args, **kwargs):
            return _StubResp(resp_status, {
                "aud": "client-123.apps.googleusercontent.com",
                "email_verified": "true",
                "email": "soc@example.com",
                "iss": iss,
            })

    monkeypatch.setattr("app.services.http_client.get_http_client", lambda: _FakeClient())


@pytest.mark.asyncio
async def test_google_token_accepts_official_issuers(monkeypatch):
    from app.routes.auth import verify_google_id_token

    _setup_google(monkeypatch, iss="https://accounts.google.com")
    claims = await verify_google_id_token("sometoken")
    assert claims["email"] == "soc@example.com"

    _setup_google(monkeypatch, iss="accounts.google.com")
    assert (await verify_google_id_token("sometoken2"))["email"] == "soc@example.com"


@pytest.mark.asyncio
async def test_google_token_rejects_foreign_issuer(monkeypatch):
    from fastapi import HTTPException
    from app.routes.auth import verify_google_id_token

    _setup_google(monkeypatch, iss="https://evil.example.com")
    with pytest.raises(HTTPException) as exc_info:
        await verify_google_id_token("sometoken")
    assert exc_info.value.status_code == 401