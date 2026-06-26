"""Shared YTMusic client wrapper with SSL retry logic.

Python 3.11+ on Debian Bookworm has well-documented OpenSSL compatibility
issues with certain CDNs (including YouTube's). This wrapper handles
transient SSL EOF errors by retrying with a relaxed SSL context.

Usage:
    from app.services.ytmusic import get_ytmusic
    yt = get_ytmusic()
    results = await asyncio.to_thread(yt.search, "lofi", filter="songs")
"""

import logging
from typing import Optional

logger = logging.getLogger("strumm-ytmusic")

_YTMusic = None


def _get_ytmusic_class():
    """Lazy-import YTMusic (avoids circular imports)."""
    global _YTMusic
    if _YTMusic is None:
        from ytmusicapi import YTMusic
        _YTMusic = YTMusic
    return _YTMusic


def get_ytmusic() -> object:
    """Return a YTMusic instance, falling back to unverified SSL on failure.

    The first attempt uses standard certificate verification. If an SSL EOF
    error occurs (common in slim Docker containers), a second attempt is made
    with certificate verification disabled.
    """
    YTMusic = _get_ytmusic_class()

    # Attempt 1: verified SSL
    try:
        return YTMusic()
    except Exception as e:
        error_str = str(e)
        if "EOF" not in error_str and "SSL" not in error_str and "handshake" not in error_str.lower():
            raise  # Not an SSL issue, re-raise immediately

    logger.warning(
        "YTMusic SSL handshake failed with verification, "
        "retrying without certificate verification..."
    )

    # Attempt 2: unverified SSL (frequent fix in slim containers)
    import ssl
    original = ssl._create_default_https_context
    ssl._create_default_https_context = ssl._create_unverified_context
    try:
        return YTMusic()
    finally:
        ssl._create_default_https_context = original


def search_ytmusic_safe(q: str, filter: Optional[str] = None) -> list:
    """Wrapper around YTMusic.search with retry on SSL EOF errors.

    Retries once with unverified SSL if the first attempt fails
    due to an SSL EOF error (common in containerized environments).
    """
    import time

    for attempt in range(2):
        try:
            yt = get_ytmusic() if attempt == 0 else _get_unverified_ytmusic()
            return yt.search(q, filter=filter) if filter else yt.search(q)
        except Exception as e:
            error_str = str(e)
            if attempt == 0 and ("EOF" in error_str or "SSL" in error_str or "handshake" in error_str.lower()):
                logger.warning(
                    f"YTMusic search SSL error (attempt 1), retrying with unverified SSL..."
                )
                time.sleep(0.5)
                continue
            raise

    return []


def _get_unverified_ytmusic() -> object:
    """Create YTMusic instance with SSL verification disabled."""
    YTMusic = _get_ytmusic_class()
    import ssl
    original = ssl._create_default_https_context
    ssl._create_default_https_context = ssl._create_unverified_context
    try:
        return YTMusic()
    finally:
        ssl._create_default_https_context = original
