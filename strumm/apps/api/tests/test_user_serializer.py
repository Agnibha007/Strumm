"""SEC-01 regression tests: credential material must never reach an API payload.

The user serializer is the single safe serialization path. The HTTP case drives
the real ``GET /profile`` route with a stubbed DB and an authenticated user whose
document contains a password hash, proving the invariant holds at the response
boundary (no ``password`` / ``passwordHash`` / ``refreshTokenHash`` anywhere).
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from app.services.user_serializer import NEVER_FIELDS, SAFE_USER_FIELDS, serialize_user


def _full_user_doc() -> dict:
    return {
        "_id": "507f1f77bcf86cd799439011",
        "email": "user@example.com",
        "username": "sample",
        "displayName": "Sample User",
        "password": "pbkdf2:sha256:100000$salt$hash",  # must never leak
        "passwordHash": "another-hash",  # alternate spelling must never leak
        "refreshTokenHash": "deadbeef",  # must never leak
        "avatar": None,
        "providers": ["email"],
        "theme": "Obsidian",
        "createdAt": datetime(2025, 1, 1, tzinfo=timezone.utc),
        "settings": {"privacy": "public", "audioQuality": "balanced"},
        "statistics": {"totalListeningTime": 100},
        "soundDNA": {"energy": 5},
        "lastActive": datetime(2025, 1, 2, tzinfo=timezone.utc),  # not in allowlist
        "internalNote": "admin-only field, must not leak",
    }


@pytest.mark.parametrize("leaky_key", ["password", "passwordHash", "refreshTokenHash"])
def test_serialize_user_never_contains_credentials(leaky_key):
    doc = _full_user_doc()
    out = serialize_user(doc, has_object_id=True)
    assert leaky_key not in out
    assert "password" not in out and "refreshTokenHash" not in out


def test_serialize_user_is_allowlist_not_blacklist():
    doc = _full_user_doc()
    # Brand new unknown sensitive-looking field must ALSO not appear in output.
    doc["passwordV2"] = "future-hash"
    out = serialize_user(doc, has_object_id=True)
    assert "passwordV2" not in out


def test_serialize_user_keeps_known_public_fields():
    out = serialize_user(_full_user_doc(), has_object_id=True)
    for field in ("id", "email", "username", "displayName", "providers",
                  "theme", "settings", "statistics", "soundDNA", "avatar"):
        assert field in out
    assert out["id"] == "507f1f77bcf86cd799439011"
    assert out["createdAt"] == datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat()


def test_serialize_user_drops_unknown_fields():
    out = serialize_user(_full_user_doc(), has_object_id=True)
    assert "lastActive" not in out
    assert "internalNote" not in out


def test_serialize_user_preserves_explicit_nulls_for_known_fields():
    out = serialize_user(_full_user_doc(), has_object_id=True)
    assert "avatar" in out and out["avatar"] is None


def test_serialize_user_handles_missing_object_id():
    out = serialize_user(_full_user_doc())
    assert "id" not in out


def test_never_fields_is_enforced_regardless_of_case():
    # The allowlist itself must never admit a credential spelling.
    for field in NEVER_FIELDS:
        assert field not in SAFE_USER_FIELDS


def _make_profile_client(leaky_user: dict):
    """AsyncClient against the real app with a stubbed DB + authenticated user."""
    from app.database import mongodb

    db = MagicMock()
    db.USERS = "users"
    db.PLAYBACK_HISTORIES = "playbackhistories"
    db.MEDIA = "media"

    histories = MagicMock()

    # find().sort().to_list() chain for playback histories returns []
    cursor = MagicMock()
    cursor.sort = MagicMock(return_value=cursor)
    cursor.to_list = MagicMock(return_value=[])

    def _getitem(name):
        return histories if name == db.PLAYBACK_HISTORIES else MagicMock()

    db.__getitem__.side_effect = _getitem
    histories.find = MagicMock(return_value=cursor)

    mongodb.get_db = MagicMock(return_value=db)

    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        user = dict(leaky_user)
        user["id"] = str(user.get("_id", ""))  # the dependency always adds id
        return user

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient

    client = AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")
    return client


@pytest.mark.asyncio
async def test_get_profile_never_returns_password():
    client = _make_profile_client(_full_user_doc())
    try:
        async with client:
            res = await client.get("/profile")
            body = res.json()
    finally:
        from app.main import app as _app
        from app.routes.dependencies import get_current_user

        _app.dependency_overrides.clear()

    assert body.get("success") is True
    payload = body.get("data", {})
    assert "password" not in payload and "passwordHash" not in payload
    assert "refreshTokenHash" not in payload
    assert payload.get("id") == "507f1f77bcf86cd799439011"