"""Shared YTMusic client wrapper with TLS 1.2 enforcement and SSL fallback.

YouTube's CDN terminates TLS connections in ways that trigger SSLEOFError
with Python 3.11+'s OpenSSL 3.x on Debian Bookworm (the default slim image).
This wrapper works around it by:

1. Mounting a custom HTTPAdapter on YTMusic's internal session that forces
   TLS 1.2 (YouTube's minimum) and retries with relaxed verification on failure.
2. Falling back to unverified SSL if the first attempt fails.

Usage:
    from app.services.ytmusic import get_ytmusic, search_ytmusic_safe

    # For general use (stream, lyrics, etc.):
    yt = get_ytmusic()
    result = yt.get_watch_playlist(videoId="...")

    # For search (which needs retry on SSL errors at the HTTP level):
    results = search_ytmusic_safe("lofi", filter="songs")
"""

import logging
import ssl
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


def _patch_session(yt_instance: object, verify: bool = True) -> None:
    """Mount a custom HTTPS adapter that enforces TLS 1.2 on the YTMusic session.

    YouTube's minimum TLS version is 1.2. On some container runtimes the
    default OpenSSL negotiation fails. This adapter pins the minimum to 1.2
    and optionally disables cert verification.
    """
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.ssl_ import create_urllib3_context

        session = yt_instance._session

        class _YouTubeAdapter(HTTPAdapter):
            def init_poolmanager(self, *args, **kwargs):
                ctx = create_urllib3_context()
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
                ctx.maximum_version = ssl.TLSVersion.TLSv1_2
                ctx.check_hostname = verify
                ctx.verify_mode = ssl.CERT_REQUIRED if verify else ssl.CERT_NONE
                kwargs["ssl_context"] = ctx
                return super().init_poolmanager(*args, **kwargs)

            def send(self, *args, **kwargs):
                kwargs.setdefault("verify", verify)
                return super().send(*args, **kwargs)

        adapter = _YouTubeAdapter()
        session.mount("https://music.youtube.com", adapter)
        session.mount("https://", adapter)
    except Exception as e:
        logger.warning(f"Failed to patch YTMusic session (non-fatal): {e}")


def get_ytmusic() -> object:
    """Return a YTMusic instance with TLS 1.2 enforced and SSL fallback.

    Creates the instance with a custom session that forces TLS 1.2.
    If construction fails with an SSL error, retries with verification
    disabled.
    """
    YTMusic = _get_ytmusic_class()

    for verify in [True, False]:
        try:
            yt = YTMusic()
            _patch_session(yt, verify=verify)
            return yt
        except Exception as e:
            error_str = str(e)
            if verify and ("EOF" in error_str or "SSL" in error_str or "handshake" in error_str.lower()):
                logger.warning(
                    "YTMusic creation failed with verified SSL, "
                    "retrying without certificate verification..."
                )
                continue
            raise


def search_ytmusic_safe(q: str, filter: Optional[str] = None) -> list:
    """Wrapper around YTMusic.search with TLS fallback on SSL EOF errors.

    Retries once with verification disabled if the first attempt fails
    due to an SSL EOF error.
    """
    import time

    for attempt in range(2):
        verify = attempt == 0
        try:
            yt = get_ytmusic() if verify else _get_unverified_ytmusic()
            return yt.search(q, filter=filter) if filter else yt.search(q)
        except Exception as e:
            error_str = str(e)
            if attempt == 0 and ("EOF" in error_str or "SSL" in error_str or "handshake" in error_str.lower()):
                logger.warning(
                    "YTMusic search SSL error (attempt 1), "
                    "retrying with unverified SSL..."
                )
                time.sleep(0.5)
                continue
            raise

    return []


def _get_unverified_ytmusic() -> object:
    """Create YTMusic instance with TLS 1.2 and SSL verification disabled."""
    YTMusic = _get_ytmusic_class()
    yt = YTMusic()
    _patch_session(yt, verify=False)
    return yt
