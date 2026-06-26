"""Simple YTMusic wrapper that forces TLS 1.2 + disables SSL verification.

YouTube's CDN triggers SSLEOFError with Python 3.11's default OpenSSL on
Debian Bookworm. The fix is simple: force TLS 1.2 on the requests session
and skip certificate verification (YouTube's API is public).

Usage:
    from app.services.ytmusic import get_ytmusic, search_ytmusic_safe

    yt = get_ytmusic()
    result = yt.get_watch_playlist(videoId="...")
    songs = search_ytmusic_safe("lofi", filter="songs")
"""

import logging
import ssl

from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

logger = logging.getLogger("strumm-ytmusic")

_YTMusic = None


def _get_class():
    global _YTMusic
    if _YTMusic is None:
        from ytmusicapi import YTMusic
        _YTMusic = YTMusic
    return _YTMusic


def get_ytmusic():
    """Return a YTMusic instance with TLS 1.2 forced + SSL verification off."""
    YTMusic = _get_class()
    yt = YTMusic()

    try:
        session = yt._session

        class _Adapter(HTTPAdapter):
            def init_poolmanager(self, *args, **kwargs):
                ctx = create_urllib3_context()
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
                ctx.maximum_version = ssl.TLSVersion.TLSv1_2
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                kwargs["ssl_context"] = ctx
                return super().init_poolmanager(*args, **kwargs)

            def send(self, *args, **kwargs):
                kwargs.setdefault("verify", False)
                return super().send(*args, **kwargs)

        adapter = _Adapter()
        session.mount("https://music.youtube.com", adapter)
        session.mount("https://", adapter)
    except Exception as e:
        logger.warning(f"Session patch failed (non-fatal): {e}")

    return yt


def search_ytmusic_safe(q, filter=None):
    """Search YTMusic. Returns results list on success, empty list on error."""
    try:
        yt = get_ytmusic()
        return yt.search(q, filter=filter) if filter else yt.search(q)
    except Exception as e:
        logger.error(f"YTMusic search failed: {e}")
        return []


def call_ytmusic_safe(method, *args, **kwargs):
    """Call any YTMusic method. Returns result on success, None on error."""
    try:
        yt = get_ytmusic()
        return getattr(yt, method)(*args, **kwargs)
    except Exception as e:
        logger.error(f"YTMusic {method} failed: {e}")
        return None
