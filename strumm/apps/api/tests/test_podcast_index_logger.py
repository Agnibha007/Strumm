"""REL-01: podcast_index module logger regression test.

`get_episode_by_id` must emit errors through a defined module logger rather than
raising NameError on an undefined `logger`, which would convert every upstream
failure into a crash instead of a graceful ``None``.
"""

from __future__ import annotations

import pytest


def test_get_episode_by_id_logs_error_and_returns_none(monkeypatch):
    import logging

    from app.services import podcast_index

    class _Recorder(logging.Handler):
        def __init__(self):
            super().__init__()
            self.records = []

        def emit(self, record):
            self.records.append(record)

    recorder = _Recorder()
    module_logger = logging.getLogger("app.services.podcast_index")
    module_logger.addHandler(recorder)
    module_logger.setLevel(logging.ERROR)
    module_logger.propagate = False
    try:
        async def _boom(*args, **kwargs):
            raise RuntimeError("upstream exploded")

        monkeypatch.setattr(podcast_index, "_get", _boom)

        async def go():
            return await podcast_index.get_episode_by_id("123")

        result = asyncio_run(go)
        assert result is None

        messages = [r.getMessage() for r in recorder.records if r.name == "app.services.podcast_index"]
        assert any("Failed to fetch episode 123" in m for m in messages)
    finally:
        module_logger.removeHandler(recorder)
        module_logger.propagate = True


import asyncio


def asyncio_run(coro):
    return asyncio.run(coro())