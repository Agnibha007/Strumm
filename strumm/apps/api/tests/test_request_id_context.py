"""Regression tests: per-request request_id must be coroutine-local.

Historically the middleware stored ``request_id`` in ``threading.local()``.
Async requests sharing one worker thread overwrote each other's ID when their
coroutines interleaved, so log lines from concurrent requests carried the wrong
request_id. The value must live in a ``contextvars.ContextVar`` so each
coroutine sees its own ID and no value leaks into a later request.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from app.main import RequestIDFilter, request_id_ctx


class _CaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_request_id_ctx_default_is_system():
    assert request_id_ctx.get() == "system"


@pytest.mark.asyncio
async def test_interleaved_coroutines_keep_distinct_request_ids():
    logger = logging.getLogger("strumm-test-request-id")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    capture = _CaptureHandler()
    logger.addHandler(capture)
    logger.addFilter(RequestIDFilter())

    async def worker(who: str, delay: float) -> None:
        token = request_id_ctx.set(f"rid-{who}")
        try:
            await asyncio.sleep(delay)  # yield the loop so coroutines interleave
            logger.info("log from %s", who)
        finally:
            request_id_ctx.reset(token)

    try:
        await asyncio.gather(worker("A", 0.05), worker("B", 0.0))
    finally:
        logger.removeHandler(capture)
        logger.removeFilter(RequestIDFilter())

    ids = {r.request_id for r in capture.records}
    assert ids == {"rid-A", "rid-B"}


@pytest.mark.asyncio
async def test_context_is_reset_after_request_no_leak():
    async def in_request() -> None:
        token = request_id_ctx.set("once")
        request_id_ctx.reset(token)

    await in_request()
    assert request_id_ctx.get() == "system"