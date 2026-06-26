"""YTMusic wrapper: TLS 1.2 + SSL off + retry with delays.

YouTube's CDN actively drops connections from cloud IP ranges (bot detection).
SSL config alone won't fix it. This adds:
1. TLS 1.2 forced + SSL verification off
2. Realistic browser User-Agent
3. Exponential backoff retry (3 attempts with increasing delays)
"""

import logging
import ssl
import time

# Permanently disable SSL verification globally
ssl._create_default_https_context = ssl._create_unverified_context

_YTMusic = None
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
logger = logging.getLogger("strumm-ytmusic")


def _get_class():
    global _YTMusic
    if _YTMusic is None:
        from ytmusicapi import YTMusic
        _YTMusic = YTMusic
    return _YTMusic


def _patch_session(yt):
    """Apply all SSL and header fixes to a YTMusic session."""
    # Realistic browser User-Agent
    yt._session.headers.update({"User-Agent": _UA})
    # Skip verification at the requests level
    yt._session.verify = False

    # Force TLS 1.2 via adapter
    from requests.adapters import HTTPAdapter
    from urllib3.util.ssl_ import create_urllib3_context

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
            kwargs["verify"] = False
            return super().send(*args, **kwargs)

    yt._session.mount("https://", _Adapter())


def _call(method, *args, **kwargs):
    """Call a YTMusic method with retry + exponential backoff (3 attempts)."""
    last_error = None
    for attempt in range(3):
        try:
            YTMusic = _get_class()
            yt = YTMusic()
            _patch_session(yt)
            return getattr(yt, method)(*args, **kwargs)
        except Exception as e:
            last_error = e
            err = str(e)
            is_ssl = "EOF" in err or "SSL" in err or "handshake" in err.lower()
            if attempt < 2 and is_ssl:
                delay = (attempt + 1) * 1.5  # 1.5s, 3s
                logger.warning(f"YTMusic {method} failed (attempt {attempt+1}), retrying in {delay}s...")
                time.sleep(delay)
                continue
            break

    logger.error(f"YTMusic {method} failed after 3 attempts: {last_error}")
    return None


def get_ytmusic():
    """Return a patched YTMusic instance."""
    YTMusic = _get_class()
    yt = YTMusic()
    _patch_session(yt)
    return yt


def search_ytmusic_safe(q, filter=None):
    """Search YouTube Music with retry."""
    try:
        result = _call("search", q, filter=filter) if filter else _call("search", q)
        return result or []
    except Exception as e:
        logger.error(f"Search failed: {e}")
        return []


def call_ytmusic_safe(method, *args, **kwargs):
    """Call any YTMusic method with retry."""
    return _call(method, *args, **kwargs)
