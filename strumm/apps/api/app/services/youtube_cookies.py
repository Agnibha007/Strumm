"""Load YouTube-only cookies for yt-dlp.

Blitz deployments should provide YTDLP_COOKIES_JSON_B64 as a secret environment
variable. Local or mounted deployments may instead set YTDLP_COOKIES_FILE to a
Netscape cookie file or a browser-exported JSON cookie file.

Cookie values are never logged.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger("strumm-youtube-cookies")

YTDLP_COOKIES_FILE_ENV = "YTDLP_COOKIES_FILE"
YTDLP_COOKIES_JSON_B64_ENV = "YTDLP_COOKIES_JSON_B64"


def _youtube_cookie_rows(payload: Any) -> list[str]:
    if isinstance(payload, dict):
        payload = payload.get("cookies")
    if not isinstance(payload, list):
        raise ValueError("Cookie export must be a JSON array.")

    rows: list[str] = []
    for cookie in payload:
        if not isinstance(cookie, dict):
            continue

        domain = str(cookie.get("domain") or "").strip().lower()
        normalized_domain = domain.lstrip(".")
        if normalized_domain != "youtube.com" and not normalized_domain.endswith(".youtube.com"):
            continue

        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        path = str(cookie.get("path") or "/")
        if not name or any(char in name + value + path for char in "\t\r\n"):
            continue

        include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
        secure = "TRUE" if bool(cookie.get("secure")) else "FALSE"
        try:
            expiry = int(float(cookie.get("expirationDate") or 0))
        except (TypeError, ValueError, OverflowError):
            expiry = 0

        cookie_domain = f"#HttpOnly_{domain}" if cookie.get("httpOnly") else domain
        rows.append(
            "\t".join(
                (cookie_domain, include_subdomains, path, secure, str(max(0, expiry)), name, value)
            )
        )

    if not rows:
        raise ValueError("Cookie export contains no supported YouTube cookies.")
    return rows


def _write_netscape_cookie_file(rows: list[str]) -> str:
    fd, filename = tempfile.mkstemp(prefix="strumm-ytdlp-cookies-", suffix=".txt")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as cookie_file:
            cookie_file.write("# Netscape HTTP Cookie File\n")
            cookie_file.write("# Generated at runtime by Strumm; do not commit this file.\n")
            cookie_file.write("\n".join(rows))
            cookie_file.write("\n")
    except Exception:
        try:
            os.unlink(filename)
        except OSError:
            pass
        raise
    return filename


def _convert_json_cookie_bytes(raw: bytes) -> str:
    payload = json.loads(raw.decode("utf-8"))
    return _write_netscape_cookie_file(_youtube_cookie_rows(payload))


@lru_cache(maxsize=1)
def get_ytdlp_cookiefile() -> str | None:
    """Return a Netscape-format cookie file path, materializing JSON secrets once."""
    configured_file = (os.getenv(YTDLP_COOKIES_FILE_ENV) or "").strip()
    if configured_file:
        path = Path(configured_file).expanduser()
        try:
            raw = path.read_bytes()
        except OSError:
            logger.warning("YTDLP_COOKIES_FILE is configured but cannot be read.")
            return None

        if raw.lstrip().startswith((b"[", b"{")):
            try:
                filename = _convert_json_cookie_bytes(raw)
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
                logger.warning("YTDLP_COOKIES_FILE is not a valid YouTube cookie JSON export.")
                return None
            logger.info("Loaded YouTube cookie configuration from a JSON cookie file.")
            return filename

        if not raw.startswith(b"# Netscape HTTP Cookie File") and not raw.startswith(b"# HTTP Cookie File"):
            logger.warning("YTDLP_COOKIES_FILE is not in Netscape cookie format.")
            return None
        if not path.is_file():
            logger.warning("YTDLP_COOKIES_FILE does not point to a regular file.")
            return None
        logger.info("Loaded YouTube cookie configuration from a mounted cookie file.")
        return str(path)

    encoded = (os.getenv(YTDLP_COOKIES_JSON_B64_ENV) or "").strip()
    if not encoded:
        return None

    try:
        compact = "".join(encoded.split())
        raw = base64.b64decode(compact, validate=True)
        filename = _convert_json_cookie_bytes(raw)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        logger.warning("YTDLP_COOKIES_JSON_B64 is configured but is invalid; yt-dlp will run without cookies.")
        return None

    logger.info("Loaded YouTube cookie configuration from the deployment secret.")
    return filename


def ytdlp_cookie_options() -> dict[str, str]:
    cookiefile = get_ytdlp_cookiefile()
    return {"cookiefile": cookiefile} if cookiefile else {}


def ytdlp_cookie_cli_args() -> list[str]:
    cookiefile = get_ytdlp_cookiefile()
    return ["--cookies", cookiefile] if cookiefile else []
