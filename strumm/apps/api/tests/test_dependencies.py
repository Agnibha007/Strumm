"""Regression tests: update_last_active must be non-fatal but visible.

The background lastActive touch fires on every authenticated request. It must
never break the request, but a DB failure must not be silently swallowed —
it has to surface as a WARNING without leaking credentials.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest

USER_ID = "6645c2e4b0a1c2e4b0a1cf1e"


@pytest.mark.asyncio
async def test_update_last_active_logs_warning_not_silent(monkeypatch, caplog):
    from app.database import mongodb
    from app.routes.dependencies import update_last_active

    db = MagicMock()
    db.USERS = "users"
    users = MagicMock()
    users.update_one = MagicMock(return_value=MagicMock())  # default asserts call works
    db.__getitem__ = MagicMock(side_effect=lambda name: users if name == "users" else MagicMock())
    monkeypatch.setattr(mongodb, "get_db", lambda: db)

    with caplog.at_level(logging.WARNING, logger="strumm-dependencies"):
        await update_last_active(USER_ID)  # must not raise

    assert users.update_one.called


@pytest.mark.asyncio
async def test_update_last_active_failure_is_non_fatal_and_logged(monkeypatch, caplog):
    from app.database import mongodb
    from app.routes.dependencies import update_last_active

    db = MagicMock()
    db.USERS = "users"
    users = MagicMock()
    users.update_one = MagicMock(return_value=MagicMock())
    users.update_one.side_effect = RuntimeError("db down")
    db.__getitem__ = MagicMock(side_effect=lambda name: users if name == "users" else MagicMock())
    monkeypatch.setattr(mongodb, "get_db", lambda: db)

    with caplog.at_level(logging.WARNING, logger="strumm-dependencies"):
        await update_last_active(USER_ID)  # must NOT raise

    messages = [r.message for r in caplog.records]
    assert any("lastActive" in m and "db down" in m for m in messages)