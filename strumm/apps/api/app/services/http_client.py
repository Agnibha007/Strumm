"""Shared async HTTP client with connection pooling.

All external HTTP requests should use ``get_http_client()`` instead of
creating a new ``httpx.AsyncClient`` per request.  This eliminates
repeated TCP + TLS handshakes and drastically reduces latency for
high-traffic routes (lyrics, recommendations, Groq AI, etc.).

Usage::

    from app.services.http_client import get_http_client

    client = get_http_client()
    resp = await client.get("https://example.com", timeout=8.0)
"""

from __future__ import annotations

import httpx
import logging

logger = logging.getLogger("strumm-http-client")

_client: httpx.AsyncClient | None = None

DEFAULT_TIMEOUT = httpx.Timeout(
    connect=5.0,
    read=10.0,
    write=5.0,
    pool=5.0,
)

DEFAULT_LIMITS = httpx.Limits(
    max_connections=50,
    max_keepalive_connections=20,
    keepalive_expiry=30,
)


def get_http_client() -> httpx.AsyncClient:
    """Return the module-level shared ``httpx.AsyncClient``.

    The client is created lazily on first call and reused for the
    lifetime of the process.  It provides:
    * Persistent connection pooling (50 max, 20 keepalive)
    * Reasonable timeouts (5s connect, 10s read)
    * Automatic keep-alive (30s expiry)
    """
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=DEFAULT_TIMEOUT,
            limits=DEFAULT_LIMITS,
            follow_redirects=True,
            headers={
                "User-Agent": "Strumm/1.0 (https://strumm.me)",
            },
        )
        logger.info("Shared httpx.AsyncClient created (pool: 50/20)")
    return _client


async def close_http_client() -> None:
    """Gracefully close the shared HTTP client on shutdown."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
        _client = None
        logger.info("Shared httpx.AsyncClient closed.")
