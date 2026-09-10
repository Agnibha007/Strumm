"""Regression tests: the cached user dict must be isolated from handler mutation.

The auth dependency caches the fresh DB user and hands a reference to every
handler. If a handler mutates the dict it receives (e.g. /profile decorating
``current_user["soundDNA"]``), the mutation used to poison the shared cache
entry for other requests within the 15s TTL window. Both the cache access path
and the fresh-fetch path must return a copy.
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")

import pytest
from bson import ObjectId

from app.services import auth_utils

auth_utils.JWT_SECRET = os.environ["JWT_SECRET"]

from app.services.auth_utils import create_access_token
from app.services.cache import cache_user, get_cached_user

USER_ID = "6645c2e4b0a1c2e4b0a1cf1e"  # unique per suite to avoid cross-test cache hits


def test_get_cached_user_returns_shallow_copy():
    key = f"user:{USER_ID}-service"
    original = {"id": "u1", "soundDNA": None, "settings": {"theme": "x"}}
    cache_user(key, original)

    handed = get_cached_user(key)
    handed["soundDNA"] = {"energy": 5}  # top-level key mutation (the reported bug)

    assert get_cached_user(key)["soundDNA"] is None
    assert get_cached_user(key) is not handed


def test_get_cached_user_missing_key_returns_none():
    assert get_cached_user("user:definitely-missing") is None


@pytest.mark.asyncio
async def test_get_current_user_returns_isolated_copy():
    from app.database import mongodb
    from app.routes.dependencies import get_current_user

    token = create_access_token({"sub": USER_ID, "email": "a@b.com", "username": "a"})

    db = MagicMock()
    db.USERS = "users"
    users = MagicMock()
    users.find_one = AsyncMock(
        return_value={
            "_id": ObjectId(USER_ID),
            "email": "a@b.com",
            "username": "a",
            "settings": {"theme": "x"},
        }
    )
    db.__getitem__ = MagicMock(side_effect=lambda name: users if name == "users" else MagicMock())
    mongodb.get_db = MagicMock(return_value=db)

    bg = MagicMock()
    first = await get_current_user(bg, authorization=f"Bearer {token}")
    first["soundDNA"] = {"energy": 5}  # /profile exception path mutates the handed dict

    second = await get_current_user(bg, authorization=f"Bearer {token}")
    assert first is not second
    assert "soundDNA" not in second
    # The cache entry itself must still be unmutated.
    assert get_cached_user(f"user:{USER_ID}").get("soundDNA") is None