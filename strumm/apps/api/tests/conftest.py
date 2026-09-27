"""Shared test fixtures.

The rate limiter is a process-wide singleton (`app.main.rate_limiter`) keyed by
client IP. Every test client here connects from the same address, and unlisted
routes all share the general 100-requests-per-10-seconds bucket, so without an
isolation reset one test file's traffic can rate-limit a later one. That made the
suite order-dependent and time-dependent: `test_rooms.py` passed on its own but
429'd in a full run, purely because earlier files had spent the shared budget.

Resetting before each test makes the suite order-independent. Tests that want to
exercise rate limiting (see `test_security_headers.py`) seed
`rate_limiter._clients` inside the test body, after this reset, so they are
unaffected.
"""
import pytest


@pytest.fixture(autouse=True)
def _isolate_rate_limiter():
    from app.main import rate_limiter

    rate_limiter._clients = {}
    yield
    rate_limiter._clients = {}
