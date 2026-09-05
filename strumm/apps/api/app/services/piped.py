"""
Piped instance manager + fetch helpers.

Public Piped instances are flaky (403 / 429 / 5xx / 526 / timeouts) and the
unhealthy instance can change over time. This module centralizes *which*
instances to try, in what order, and with what backoff, so every Piped call in
the app (``/yt/*`` routes, direct-audio fallback, search fallback) shares one
decision policy:

* **Rotation** — a request tries up to ``PIPED_MAX_INSTANCES_PER_REQUEST``
  healthy instances and moves on when one fails (403, 429, 5xx, 526, timeout,
  connection error, unusable body).
* **Cooldown (circuit breaker)** — a failing instance is excluded from
  candidates for a growing period (30s, 60s, 120s, ... capped at 300s).
  Success resets it, so a recovered instance is re-admitted quickly.
* **Success preference** — the most-recently-successful healthy instance is
  tried first, so requests stop hammering an unhealthy first-configured
  instance while a healthier one exists.

State is process-local and thread-safe (a lock + monotonic clocks). It is
deliberately NOT distributed: multiple replicas each keep their own view,
which is fine because every instance is idempotent to hit (GET only) and the
worst case is a redundant request, never corruption.

No large media bytes are ever transferred through these helpers — they fetch
metadata / stream-location JSON only.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Any, Callable, Optional

logger = logging.getLogger("strumm-piped")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Public Piped instance API roots, tried in order. Piped is keyless — no API
# key, no per-app quota — and the instance performs the YouTube request, so
# these stay reachable from cloud IPs that Google's CDN blocks directly.
#
# CONFIGURABLE via the ``PIPED_INSTANCES`` env var (comma-separated URLs);
# when unset it defaults to the maintained list below.
PIPED_DEFAULT_INSTANCES = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.r4fo.com",
]


def _load_piped_instances() -> list[str]:
    """Read the configured Piped instance roots, validating each entry.

    Values may be comma-separated in the ``PIPED_INSTANCES`` env var. Entries
    are stripped of trailing slashes; blank entries are dropped. On any parsing
    problem the default list is used so a broken env value can never leave the
    provider with zero instances.
    """
    raw = (os.getenv("PIPED_INSTANCES") or "").strip()
    if not raw:
        return list(PIPED_DEFAULT_INSTANCES)
    entries = [
        p.strip().rstrip("/") for p in raw.split(",") if p.strip() and p.strip().rstrip("/")
    ]
    if not entries or not all(e.startswith("http") for e in entries):
        logger.warning("PIPED_INSTANCES env var is empty or invalid; using default instances.")
        return list(PIPED_DEFAULT_INSTANCES)
    return entries


PIPED_INSTANCES = _load_piped_instances()

# Per-request budget. The browser's proxyGet aborts at 12s, so every Piped
# call must finish well inside that; racing up to two healthy instances with a
# 6s read cap keeps the whole chain under ~6-7s even when both are dead.
PIPED_CONNECT_TIMEOUT = 3.0
PIPED_READ_TIMEOUT = 6.0
PIPED_TIMEOUT = (PIPED_CONNECT_TIMEOUT, PIPED_READ_TIMEOUT)  # requests-style

# Circuit-breaker timing (seconds).
PIPED_COOLDOWN_BASE = 30.0     # first failure
PIPED_COOLDOWN_FACTOR = 2.0    # exponential growth
PIPED_COOLDOWN_MAX = 300.0     # cap
PIPED_MAX_INSTANCES_PER_REQUEST = int(
    os.getenv("PIPED_MAX_INSTANCES_PER_REQUEST", "2")
)  # concurrent (async) / sequential (sync) attempts per call

# A 200 response whose body lacks these keys is treated as unusable (the
# instance answered but with a shape we can't consume). Callers may override.
DEFAULT_REQUIRE_KEYS: tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# Instance health state (thread-safe, process-local)
# ---------------------------------------------------------------------------


class _InstanceState:
    __slots__ = ("failures", "last_failure", "cooldown_until", "last_success")

    def __init__(self) -> None:
        self.failures = 0
        self.last_failure = 0.0
        self.cooldown_until = 0.0
        self.last_success = 0.0


class PipedHealth:
    """Per-instance consecutive-failure / cooldown / last-success tracking."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, _InstanceState] = {}

    def _st(self, base: str) -> _InstanceState:
        st = self._state.get(base)
        if st is None:
            st = _InstanceState()
            self._state[base] = st
        return st

    def _cooldown_seconds(self, failures: int) -> float:
        if failures <= 1:
            return PIPED_COOLDOWN_BASE
        return min(PIPED_COOLDOWN_BASE * (PIPED_COOLDOWN_FACTOR ** (failures - 1)), PIPED_COOLDOWN_MAX)

    def ordered_healthy(self) -> list[str]:
        """Instances not currently cooling down, most-preferred first.

        Preference: last successful (most recent first), then fewest
        consecutive failures, then configured order. Instances in cooldown are
        excluded entirely so request budget is never wasted on a known-bad one.
        """
        now = time.monotonic()
        with self._lock:
            healthy = [
                base for base in PIPED_INSTANCES
                if self._st(base).cooldown_until <= now
            ]
            def key(base: str) -> tuple[int, float, int, int]:
                st = self._st(base)
                idx = PIPED_INSTANCES.index(base)
                # reverse=True sorts all fields descending; negate the fields
                # that must sort ascending (failures, then configured order).
                return (1 if st.last_success > 0 else 0, st.last_success, -st.failures, -idx)
            return sorted(healthy, key=key, reverse=True)
    def record_failure(self, base: str, reason: str = "") -> None:
        """Mark one failed attempt for ``base``; grows its cooldown."""
        with self._lock:
            st = self._st(base)
            st.failures += 1
            st.last_failure = time.monotonic()
            st.cooldown_until = time.monotonic() + self._cooldown_seconds(st.failures)
            wait = self._cooldown_seconds(st.failures)
        logger.warning(
            "Piped %s marked unhealthy (%d consecutive failure(s)%s); cooling down %.0fs",
            base, st.failures, f": {reason}" if reason else "", wait,
        )

    def record_success(self, base: str) -> None:
        """Reset failure state after a successful response."""
        with self._lock:
            st = self._st(base)
            was_bad = st.failures > 0 or st.cooldown_until > time.monotonic()
            st.failures = 0
            st.cooldown_until = 0.0
            st.last_success = time.monotonic()
        if was_bad:
            logger.info("Piped %s recovered (successful response)", base)

    def record_empty(self, base: str) -> None:
        """The instance answered 200 but with an unusable body.

        Counted as a failure for ordering purposes only — no hard cooldown,
        since the instance did respond.
        """
        with self._lock:
            st = self._st(base)
            st.failures += 1
            st.last_failure = time.monotonic()
            st.cooldown_until = 0.0

    def snapshot(self) -> dict[str, dict[str, Any]]:
        now = time.monotonic()
        with self._lock:
            return {
                base: {
                    "failures": self._st(base).failures,
                    "last_failure": self._st(base).last_failure,
                    "last_success": self._st(base).last_success,
                    "in_cooldown": self._st(base).cooldown_until > now,
                    "cooldown_remaining_s": round(max(0.0, self._st(base).cooldown_until - now), 1),
                }
                for base in PIPED_INSTANCES
            }

    def reset(self) -> None:
        with self._lock:
            self._state.clear()


health = PipedHealth()


def reset_health() -> None:
    """Clear all instance health state (used by tests / diagnostics)."""
    health.reset()


# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------

# HTTP statuses that mean "this instance is bad right now" (try another).
UNHEALTHY_STATUSES = frozenset({403, 429, 500, 502, 503, 504, 526})


def is_unhealthy_status(status_code: int) -> bool:
    return status_code in UNHEALTHY_STATUSES or status_code >= 500


# ---------------------------------------------------------------------------
# Transport helpers
# ---------------------------------------------------------------------------


def _async_client():
    """Resolve the shared httpx client (imported lazily to avoid cycles)."""
    from app.services.http_client import get_http_client
    return get_http_client()


async def _attempt_async(base: str, path: str, params: Optional[dict], timeout: Any) -> Optional[dict]:
    """One async attempt against ``base``. Returns a JSON object or None."""
    try:
        client = _async_client()
        resp = await client.get(f"{base}{path}", params=params, timeout=timeout)
    except Exception as exc:  # timeout / conn / TLS
        health.record_failure(base, f"{type(exc).__name__}")
        return None
    if resp.status_code != 200:
        health.record_failure(base, f"HTTP {resp.status_code}")
        return None
    try:
        payload = resp.json()
    except Exception as exc:
        health.record_failure(base, f"invalid JSON: {type(exc).__name__}")
        return None
    return payload


def _attempt_sync(base: str, path: str, params: Optional[dict], timeout: Any) -> Optional[dict]:
    """One synchronous attempt against ``base`` (for to_thread contexts)."""
    import requests

    try:
        resp = requests.get(f"{base}{path}", params=params, timeout=timeout)
    except Exception as exc:  # timeout / conn / TLS
        health.record_failure(base, f"{type(exc).__name__}")
        return None
    if resp.status_code != 200:
        health.record_failure(base, f"HTTP {resp.status_code}")
        return None
    try:
        payload = resp.json()
    except Exception as exc:
        health.record_failure(base, f"invalid JSON: {type(exc).__name__}")
        return None
    return payload


def _usable(payload: Optional[dict], require_keys: tuple[str, ...]) -> bool:
    if not isinstance(payload, dict):
        return False
    if require_keys and not any(k in payload for k in require_keys):
        return False
    return True


async def piped_fetch_json_async(
    path: str,
    params: Optional[dict] = None,
    *,
    timeout: Any = None,
    max_instances: Optional[int] = None,
    require_keys: tuple[str, ...] = DEFAULT_REQUIRE_KEYS,
) -> Optional[tuple[str, dict]]:
    """Fetch ``path`` from healthy Piped instances, racing up to
    ``max_instances`` of them concurrently.

    Returns ``(base, payload)`` for the first healthy instance that returns a
    usable 200 JSON body, or ``None`` when every attempt failed. Loser
    requests are cancelled as soon as a winner is known. Each failed attempt
    feeds the circuit breaker.
    """
    max_instances = max(1, max_instances or PIPED_MAX_INSTANCES_PER_REQUEST)
    candidates = health.ordered_healthy()[:max_instances]
    if not candidates:
        return None

    if timeout is None:
        from httpx import Timeout as HttpxTimeout
        timeout = HttpxTimeout(
            connect=PIPED_CONNECT_TIMEOUT,
            read=PIPED_READ_TIMEOUT,
            write=PIPED_CONNECT_TIMEOUT,
            pool=PIPED_CONNECT_TIMEOUT,
        )

    async def attempt(base: str) -> Optional[tuple[str, dict]]:
        payload = await _attempt_async(base, path, params, timeout)
        if not _usable(payload, require_keys):
            if payload is not None:
                # Answered but unusable: ordering penalty only, no cooldown.
                health.record_empty(base)
            return None
        health.record_success(base)
        return (base, payload)

    tasks = [asyncio.create_task(attempt(b)) for b in candidates]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    while True:
        for task in list(done):
            result = task.result()
            if result is not None:
                for p in pending:
                    p.cancel()
                # Cancel must complete before we leave the event loop cleanly.
                for p in pending:
                    try:
                        await p
                    except (asyncio.CancelledError, Exception):
                        pass
                return result
        if not pending:
            return None
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)


def piped_fetch_json_sync(
    path: str,
    params: Optional[dict] = None,
    *,
    timeout: Any = None,
    max_instances: Optional[int] = None,
    require_keys: tuple[str, ...] = DEFAULT_REQUIRE_KEYS,
) -> Optional[tuple[str, dict]]:
    """Fetch ``path`` from healthy Piped instances sequentially (sync context).

    Same contract as :func:`piped_fetch_json_async` but for callers running in
    worker threads (``asyncio.to_thread``); attempts are sequential to keep
    concurrency bounded.
    """
    max_instances = max(1, max_instances or PIPED_MAX_INSTANCES_PER_REQUEST)
    candidates = health.ordered_healthy()[:max_instances]
    if not candidates:
        return None
    timeout = timeout or PIPED_TIMEOUT
    for base in candidates:
        payload = _attempt_sync(base, path, params, timeout)
        if not _usable(payload, require_keys):
            if payload is not None:
                # answered but unusable: ordering penalty only, no cooldown
                health.record_empty(base)
            continue
        health.record_success(base)
        return (base, payload)
    return None