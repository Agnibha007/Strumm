"""
Object storage service — currently backed by Backblaze B2 via its
S3-compatible API (MinIO client).

This module is the *only* place in the codebase that knows about B2 / S3.
The rest of the application depends on the high-level functions exposed here
(create_upload_url, create_download_url, delete_object, object_exists), which
return presigned URLs and object keys — the B2 application key is never
exposed to clients.

Configuration (environment variables):

    B2_ENDPOINT           e.g. https://s3.eu-central-003.backblazeb2.com
    B2_REGION             e.g. eu-central-003
    B2_BUCKET_NAME        e.g. strumm-media-prod
    B2_KEY_ID             Backblaze application key ID     (secret)
    B2_APPLICATION_KEY    Backblaze application key secret (secret)

The MinIO client is imported lazily so the module (and therefore the whole
application) can be imported and tested even when the dependency is not
installed in a running environment. When B2 is not configured, the service
raises StorageUnavailableError rather than silently no-oping.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
import uuid
from datetime import timedelta
from typing import Any, Optional

logger = logging.getLogger("strumm-storage")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

B2_ENDPOINT = (os.getenv("B2_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com")).rstrip("/")
B2_REGION = os.getenv("B2_REGION", "eu-central-003")
B2_BUCKET = os.getenv("B2_BUCKET_NAME") or "strumm-media-prod"
B2_KEY_ID = os.getenv("B2_KEY_ID", "").strip()
B2_APP_KEY = os.getenv("B2_APPLICATION_KEY", "").strip()

# How long clients may use a presigned URL before it expires.
UPLOAD_URL_EXPIRES = timedelta(minutes=15)
DOWNLOAD_URL_EXPIRES = timedelta(minutes=15)

# ---------------------------------------------------------------------------
# Media categories & validation
# ---------------------------------------------------------------------------

CATEGORY_AVATAR = "avatar"
CATEGORY_IMAGE = "image"
CATEGORY_AUDIO = "audio"
CATEGORIES = (CATEGORY_AVATAR, CATEGORY_IMAGE, CATEGORY_AUDIO)

# category -> allowed MIME prefix(es)
ALLOWED_MIME_PREFIXES: dict[str, tuple[str, ...]] = {
    CATEGORY_AVATAR: ("image/",),
    CATEGORY_IMAGE: ("image/",),
    CATEGORY_AUDIO: ("audio/", "video/"),
}

# category -> max bytes
MAX_FILE_BYTES: dict[str, int] = {
    CATEGORY_AVATAR: 2_000_000,       # 2 MB
    CATEGORY_IMAGE: 5_000_000,        # 5 MB
    CATEGORY_AUDIO: 200_000_000,      # 200 MB
}

# Characters not allowed in a stored object key segment.
_UNSAFE_KEY_RE = re.compile(r"[^A-Za-z0-9._-]+")


class StorageError(Exception):
    """Base class for object-storage failures."""


class StorageUnavailableError(StorageError):
    """Raised when object storage is not configured or unreachable."""


class StorageValidationError(StorageError):
    """Raised when an upload request fails category / MIME / size validation."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def storage_enabled() -> bool:
    """True when B2 credentials are present and the service can be used."""
    return bool(B2_ENDPOINT and B2_KEY_ID and B2_APP_KEY and B2_BUCKET)


def sanitize_filename(filename: Optional[str]) -> str:
    """Return a safe, storage-friendly base filename.

    Strips any path components, collapses non-safe characters to '_', and
    never allows an empty / dotfile result. The returned value is *not* used
    as the object key alone — callers prepend a unique segment to prevent
    collisions.
    """
    if not filename:
        return "file"
    base = os.path.basename(str(filename).replace("\\", "/")).strip()
    cleaned = _UNSAFE_KEY_RE.sub("_", base).strip("._ ")
    return cleaned[:120] or "file"


def _safe_id(value: str) -> str:
    """Sanitize an owner/media id for safe inclusion in an object key."""
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(value))[:64]
    return cleaned or "unknown"


def build_object_key(category: str, owner_id: str, filename: str, media_id: Optional[str] = None) -> str:
    """Build a predictable, collision-resistant B2 object key.

    Keys are namespaced by category and owner; a random unique segment is
    prepended to the (sanitized) filename so two uploads never collide.

    Example keys:
        users/{ownerId}/avatar/{uuid}-{filename}
        media/{ownerId}/{mediaId}/{uuid}-{filename}
        audio/{ownerId}/{mediaId}/{uuid}-{filename}
    """
    if category not in CATEGORIES:
        raise StorageValidationError(f"Unknown media category: {category}")
    owner = _safe_id(owner_id)
    unique = uuid.uuid4().hex
    safe_name = sanitize_filename(filename)
    mid = _safe_id(media_id) if media_id else unique
    if category == CATEGORY_AVATAR:
        return f"users/{owner}/avatar/{unique}-{safe_name}"
    if category == CATEGORY_AUDIO:
        return f"audio/{owner}/{mid}/{unique}-{safe_name}"
    return f"media/{owner}/{mid}/{unique}-{safe_name}"


def validate_category(category: str) -> str:
    if category not in CATEGORIES:
        raise StorageValidationError(
            f"Category must be one of: {', '.join(CATEGORIES)}."
        )
    return category


def validate_mime(category: str, content_type: Optional[str]) -> str:
    prefixes = ALLOWED_MIME_PREFIXES.get(category, ())
    if not prefixes:
        return ""
    ct = (content_type or "").lower().split(";")[0].strip()
    if not ct:
        raise StorageValidationError(f"A content type is required for category '{category}'.")
    if not ct.startswith(prefixes):
        raise StorageValidationError(
            f"Unsupported content type '{ct}' for category '{category}'."
        )
    return ct


def validate_size(category: str, size: int) -> int:
    max_bytes = MAX_FILE_BYTES.get(category)
    if max_bytes is None:
        raise StorageValidationError(f"Unknown media category: {category}")
    try:
        parsed = int(size)
    except (TypeError, ValueError):
        raise StorageValidationError("File size must be a positive integer.")
    if parsed <= 0:
        raise StorageValidationError("File size must be a positive integer.")
    if parsed > max_bytes:
        raise StorageValidationError(
            f"File size exceeds the {max_bytes} byte limit for category '{category}'."
        )
    return parsed


# -- Low-level client -------------------------------------------------------

def _b2_endpoint_host() -> str:
    """Return the host[:port] for the S3 client from the configured endpoint.

    Backblaze's S3-compatible endpoint is ``https://s3.<region>.backblazeb2.com``.
    We strip the scheme by *prefix* only (``removeprefix``). Using ``str.lstrip``
    is a known pitfall here: its argument is a character *set*, so stripping
    ``"https://"`` would also greedily consume the ``s`` that starts the ``s3``
    host, producing ``3.<region>.backblazeb2.com`` and a DNS-unresolvable host.
    """
    host = B2_ENDPOINT
    for scheme in ("https://", "http://"):
        host = host.removeprefix(scheme)
    return host.rstrip("/")


def _get_client() -> Any:
    """Build (or return) the MinIO client for the configured B2 endpoint.

    Imported lazily so the application imports cleanly without the dependency
    installed (e.g. in test environments that stub this function).
    """
    if not storage_enabled():
        raise StorageUnavailableError(
            "Object storage is not configured. Set B2_ENDPOINT, B2_KEY_ID, "
            "B2_APPLICATION_KEY and B2_BUCKET_NAME."
        )
    try:
        from minio import Minio
    except ImportError as exc:  # pragma: no cover - depends on deployment
        raise StorageUnavailableError(
            "MinIO (S3) client dependency is not installed."
        ) from exc

    return Minio(
        _b2_endpoint_host(),
        access_key=B2_KEY_ID,
        secret_key=B2_APP_KEY,
        region=B2_REGION or None,
        secure=B2_ENDPOINT.startswith("https://"),
    )


# -- High-level operations --------------------------------------------------

def create_upload_url(
    category: str,
    owner_id: str,
    filename: str,
    *,
    content_type: Optional[str] = None,
    size: int,
    media_id: Optional[str] = None,
    expires: timedelta = UPLOAD_URL_EXPIRES,
) -> dict[str, Any]:
    """Validate an upload request and return a presigned PUT URL + object key.

    The returned dict contains the B2 *object key* and a short-lived presigned
    upload URL the client can PUT the bytes to directly. The application key is
    not included.
    """
    validate_category(category)
    content_type = validate_mime(category, content_type)
    size = validate_size(category, size)

    client = _get_client()
    object_key = build_object_key(category, owner_id, filename, media_id)

    try:
        upload_url = client.get_presigned_url(
            method="PUT",
            bucket_name=B2_BUCKET,
            object_name=object_key,
            expires=expires,
        )
    except Exception as exc:
        logger.error(f"Failed to issue upload URL for key={object_key!r}: {type(exc).__name__}: {exc!s:.160}")
        raise StorageError("Could not issue an upload URL.") from exc

    return {
        "objectKey": object_key,
        "uploadUrl": upload_url,
        "category": category,
        "contentType": content_type,
        "expiresIn": int(expires.total_seconds()),
    }


def create_download_url(
    object_key: str,
    *,
    content_type: Optional[str] = None,
    expires: timedelta = DOWNLOAD_URL_EXPIRES,
) -> dict[str, Any]:
    """Return a short-lived presigned GET URL for a private object.

    Presigned B2/S3 GET URLs support HTTP Range requests natively, so media
    returned here can be played in <video>/<audio> or ranged-requested by
    browsers without proxying bytes through the backend.
    """
    client = _get_client()
    try:
        download_url = client.get_presigned_url(
            method="GET",
            bucket_name=B2_BUCKET,
            object_name=object_key,
            expires=expires,
            response_headers={"response-content-type": content_type} if content_type else None,
        )
    except Exception as exc:
        logger.error(f"Failed to issue download URL for key={object_key!r}: {type(exc).__name__}: {exc!s:.160}")
        raise StorageError("Could not issue a download URL.") from exc

    return {
        "objectKey": object_key,
        "downloadUrl": download_url,
        "expiresIn": int(expires.total_seconds()),
    }


def delete_object(object_key: str) -> None:
    """Delete an object from the bucket (respects versioning settings).

    Idempotent: removing an already-missing object is treated as success, so
    retried deletions (e.g. the unused-media cleanup after a partial failure)
    never raise.

    Versioning caveat: with B2's "Keep all versions" the DELETE creates a
    delete marker (the object is hidden, future reads 404) but any *previous*
    versions of the object remain in the bucket and still consume storage.
    Reclaiming those versions is out of scope here — see the lifecycle
    documentation in ``app.services.media_lifecycle`` for how the app treats
    this honestly and what bucket-level rule purges old versions.
    """
    client = _get_client()
    try:
        client.remove_object(B2_BUCKET, object_key)
    except Exception as exc:
        # MinIO surfaces missing objects as S3Error(code="NoSuchKey"); B2 may
        # surface a 404. Either way the goal state ("object absent") holds.
        try:
            if getattr(exc, "code", "") == "NoSuchKey":
                return
        except Exception:  # pragma: no cover - defensive
            pass
        logger.error(f"Failed to delete object key={object_key!r}: {type(exc).__name__}: {exc!s:.160}")
        raise StorageError("Could not delete the object.") from exc


def object_exists(object_key: str) -> bool:
    """Return True if the object exists in the bucket."""
    client = _get_client()
    try:
        client.stat_object(B2_BUCKET, object_key)
        return True
    except Exception:
        return False