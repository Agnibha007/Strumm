import html
import ipaddress
import os
import re
import secrets
import socket
from typing import Iterable, Optional
from urllib.parse import urlparse

from bson import ObjectId
from fastapi import Header, HTTPException, status


MAX_TEXT_LENGTH = 500
MAX_LONG_TEXT_LENGTH = 5000
YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
# Canonical YouTube video ID format (base64url, exactly 11 chars).
YOUTUBE_VIDEO_ID_STRICT_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# Podcast episodes use a synthetic "podcast-<ObjectId-hex>" videoId namespace.
PODCAST_EPISODE_ID_RE = re.compile(r"^podcast-[0-9a-fA-F]{24}$")
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,30}$")


def sanitize_text(value: Optional[str], *, max_length: int = MAX_TEXT_LENGTH) -> str:
    if value is None:
        return ""
    cleaned = " ".join(str(value).replace("\x00", "").split())
    cleaned = html.escape(cleaned, quote=True)
    return cleaned[:max_length]


def sanitize_multiline_text(value: Optional[str], *, max_length: int = MAX_LONG_TEXT_LENGTH) -> str:
    if value is None:
        return ""
    cleaned = str(value).replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    cleaned = "\n".join(" ".join(line.split()) for line in cleaned.split("\n"))
    return html.escape(cleaned.strip(), quote=True)[:max_length]


def sanitize_username(value: str) -> str:
    username = sanitize_text(value, max_length=30).lower()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("Username must be 3-30 characters and use only lowercase letters, numbers, or underscores.")
    return username


def sanitize_youtube_id(value: str) -> str:
    video_id = sanitize_text(value, max_length=32)
    if not YOUTUBE_VIDEO_ID_RE.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID.")
    return video_id


def is_valid_youtube_id(value: Any) -> bool:
    """True iff ``value`` is a canonical YouTube video ID.

    Enforces the strict canonical format ``^[A-Za-z0-9_-]{11}$``. Leading and
    trailing whitespace is ignored for the check; callers persist the stripped
    form. Non-strings (int, None, dict…) are invalid.
    """
    if not isinstance(value, str):
        return False
    return bool(YOUTUBE_VIDEO_ID_STRICT_RE.fullmatch(value.strip()))


def sanitize_youtube_id_strict(value: Optional[str]) -> str:
    """Return the stripped canonical video ID or raise ValueError.

    Rejects anything that is not a well-formed 11-char YouTube video ID. This
    is the server-side trust-boundary validator for externally supplied
    YouTube video IDs (browser candidates, parsed provider IDs).
    """
    if not isinstance(value, str):
        raise ValueError("Invalid YouTube video ID.")
    cleaned = value.strip()
    if not YOUTUBE_VIDEO_ID_STRICT_RE.fullmatch(cleaned):
        raise ValueError("Invalid YouTube video ID.")
    return cleaned


def sanitize_enum(value: Optional[str], allowed: Iterable[str], default: str) -> str:
    allowed_values = set(allowed)
    cleaned = sanitize_text(value or default, max_length=40).lower()
    if cleaned not in allowed_values:
        raise ValueError(f"Value must be one of: {', '.join(sorted(allowed_values))}.")
    return cleaned


def sanitize_positive_int(value: int, *, minimum: int = 0, maximum: int = 3600) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError("Expected an integer value.")
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"Value must be between {minimum} and {maximum}.")
    return parsed


def escaped_regex(value: str) -> dict:
    return {"$regex": re.escape(sanitize_text(value, max_length=120)), "$options": "i"}


def validate_password_strength(password: str) -> dict:
    """Validate password strength.
    Returns {"valid": True/False, "message": str}.
    """
    if len(password) < 8:
        return {"valid": False, "message": "Password must be at least 8 characters long."}
    if len(password) > 128:
        return {"valid": False, "message": "Password must be no more than 128 characters long."}
    if not re.search(r"[A-Z]", password):
        return {"valid": False, "message": "Password must contain at least one uppercase letter."}
    if not re.search(r"[a-z]", password):
        return {"valid": False, "message": "Password must contain at least one lowercase letter."}
    if not re.search(r"[0-9]", password):
        return {"valid": False, "message": "Password must contain at least one number."}
    return {"valid": True, "message": "Password meets strength requirements."}


def parse_object_id(value: str) -> ObjectId:
    cleaned = sanitize_text(value, max_length=32)
    if not ObjectId.is_valid(cleaned):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid identifier.")
    return ObjectId(cleaned)


def get_admin_api_key() -> Optional[str]:
    key = os.getenv("ADMIN_API_KEY")
    return key if key and len(key) >= 24 else None


async def require_admin(x_admin_api_key: Optional[str] = Header(None)):
    expected = get_admin_api_key()
    if not expected:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not x_admin_api_key or not secrets.compare_digest(x_admin_api_key, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def assert_public_http_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must be http or https.")

    hostname = parsed.hostname.lower()
    if hostname in {"localhost", "127.0.0.1", "::1"} or hostname.endswith(".local"):
        raise ValueError("Private or local URLs are not allowed.")

    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast:
            raise ValueError("Private or local URLs are not allowed.")
    except ValueError as exc:
        if "not allowed" in str(exc):
            raise

    try:
        for result in socket.getaddrinfo(hostname, None):
            resolved_ip = ipaddress.ip_address(result[4][0])
            if resolved_ip.is_private or resolved_ip.is_loopback or resolved_ip.is_link_local or resolved_ip.is_multicast:
                raise ValueError("Private or local URLs are not allowed.")
    except socket.gaierror:
        raise ValueError("URL host could not be resolved.")

    return url
