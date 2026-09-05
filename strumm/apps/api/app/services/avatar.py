"""
Avatar display resolution.

A user avatar is stored in one of two forms:

* **Legacy**: `users.avatar` holds a `data:image/...` base64 URI (or an external
  URL). It is rendered directly.
* **B2-backed**: `users.avatarMediaId` references a `media` record whose object
  is stored in the private Backblaze B2 bucket. It must be rendered through a
  short-lived presigned GET URL (never a permanent public URL).

This helper turns either form into a ready-to-render `avatar` string for API
responses, so the wide variety of frontend `<img src={...avatar}>` render sites
can keep working without per-avatar network requests (no N+1). For B2 avatars
it returns a freshly-signed short-lived URL; for legacy avatars it returns the
stored value unchanged.

The media collection remains the source of truth for the B2 object key. We
store/return `avatarMediaId`, never a permanent URL or base64 for new uploads.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.database import mongodb as db
from app.services import storage
from app.services.media_lifecycle import mark_media_accessed

logger = logging.getLogger("strumm-avatar")

# How long an embedded avatar URL remains valid (matches download URLs).
AVATAR_TTL = int(storage.DOWNLOAD_URL_EXPIRES.total_seconds())


async def _fetch_media_record(database, object_id):
    try:
        return await database[db.MEDIA].find_one({"_id": object_id, "deletedAt": None})
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"avatar media lookup failed: {exc!s:.160}")
        return None


async def resolve_avatar_url(avatar_media_id: Optional[str], legacy_avatar: Optional[str]) -> str | None:
    """Resolve a user's avatar into a ready-to-render URL string.

    * B2-backed (``avatar_media_id`` present + ready media record) -> signed URL
    * otherwise -> the legacy ``avatar`` value unchanged (base64 / external URL)
    * neither -> None

    Signing a B2 avatar marks it as accessed (the signed URL is how the image
    is read), shielding it from unused-media expiry.
    """
    if avatar_media_id:
        from bson import ObjectId
        if ObjectId.is_valid(str(avatar_media_id)):
            database = db.get_db()
            record = await _fetch_media_record(database, ObjectId(str(avatar_media_id)))
            if record and record.get("category") == "avatar" and record.get("status") == "ready":
                try:
                    signed_url = storage.create_download_url(record["objectKey"])["downloadUrl"]
                    await mark_media_accessed(database, record)
                    return signed_url
                except storage.StorageError:
                    logger.warning(
                        f"failed to sign avatar for media={avatar_media_id!r}; "
                        f"falling back to legacy avatar"
                    )
        return legacy_avatar or None

    return legacy_avatar or None


async def decorate_user_avatar(user: dict) -> dict:
    """Set ``avatar`` (render-ready) and ``avatarMediaId`` on a user dict in place.

    When a valid B2 avatar exists, ``avatar`` becomes a short-lived signed URL,
    ``avatarMediaId`` is echoed, and ``avatarExpiresIn`` is set (so callers can
    cache the URL). For legacy users ``avatarMediaId`` is dropped and ``avatar``
    is left unchanged. Returns the mutated user dict.
    """
    media_id = user.get("avatarMediaId")
    if media_id:
        resolved = await resolve_avatar_url(media_id, user.get("avatar"))
        user["avatar"] = resolved
        if resolved and "X-Amz-Signature" in resolved:
            user["avatarExpiresIn"] = AVATAR_TTL
        return user

    # Legacy only — ensure no stale B2 reference lingers in the response.
    if "avatarMediaId" in user:
        del user["avatarMediaId"]
    return user