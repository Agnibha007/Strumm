"""
Media routes — authenticate / authorize *before* issuing B2 presigned URLs.

The B2 bucket is private. These endpoints never hand credentials to the
frontend; they only return short-lived presigned PUT (upload) and GET
(download) URLs plus the B2 *object key* (never a permanent public URL).

Upload flow:
    POST /media/upload-url   -> {mediaId, objectKey, uploadUrl, expiresIn}
    (frontend PUTs bytes directly to uploadUrl)
    POST /media/confirm      -> mark the media record as "ready"

Access flow:
    GET /media/download-url?key=<objectKey> -> {downloadUrl, expiresIn}

Deletion flow:
    DELETE /media            -> backend authorization + B2 delete
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services import storage
from app.services.media_lifecycle import mark_media_accessed
from app.services.security import parse_object_id, sanitize_text

logger = logging.getLogger("strumm-media")
router = APIRouter(prefix="/media", tags=["media"])


def _serialize_media(record: dict) -> dict:
    record["id"] = str(record.pop("_id"))
    for key in ("createdAt", "updatedAt", "deletedAt"):
        val = record.get(key)
        if val is not None and hasattr(val, "isoformat"):
            record[key] = val.isoformat()
    return record


@router.post("/upload-url")
async def create_upload_url(
    category: str = Body(..., embed=True),
    filename: str = Body(..., embed=True),
    contentType: str = Body(None, embed=True),
    size: int = Body(..., embed=True),
    mediaId: Optional[str] = Body(None, embed=True),
    current_user: dict = Depends(get_current_user),
):
    """Authenticate + validate a direct-upload request and return a presigned PUT URL."""
    try:
        result = storage.create_upload_url(
            category,
            current_user["id"],
            filename or "file",
            content_type=contentType,
            size=size,
            media_id=mediaId,
        )
    except storage.StorageValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except storage.StorageUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except storage.StorageError as exc:
        logger.error(f"Upload URL failure for user={current_user.get('id')}: {exc!s}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Storage is temporarily unavailable.")

    media_id_hex = mediaId or ObjectId()
    record = {
        "_id": ObjectId(str(media_id_hex)) if ObjectId.is_valid(str(media_id_hex)) else ObjectId(),
        "ownerId": current_user["id"],
        "category": result["category"],
        "objectKey": result["objectKey"],
        "mime": result.get("contentType"),
        "filename": sanitize_text(result["objectKey"].rsplit("/", 1)[-1], max_length=120),
        "size": size,
        "status": "pending",
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow(),
        "deletedAt": None,
        # A brand-new upload is, by definition, "just accessed": it starts the
        # unused-media clock at zero so it cannot expire before the retention
        # window has had a chance to run.
        "lastAccessedAt": datetime.utcnow(),
    }
    database = db.get_db()
    try:
        await database[db.MEDIA].insert_one(record)
    except Exception as exc:
        logger.error(f"Failed to persist media record: {exc!s}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Storage record could not be saved.")

    return {
        "success": True,
        "data": {
            "mediaId": str(record["_id"]),
            "objectKey": result["objectKey"],
            "category": result["category"],
            "uploadUrl": result["uploadUrl"],
            "contentType": result.get("contentType"),
            "expiresIn": result["expiresIn"],
        },
    }


@router.post("/confirm")
async def confirm_upload(
    mediaId: str = Body(..., embed=True),
    current_user: dict = Depends(get_current_user),
):
    """Mark an uploaded media record as 'ready' (called after the frontend PUT succeeds)."""
    database = db.get_db()
    record = await database[db.MEDIA].find_one({"_id": parse_object_id(mediaId)})
    if not record or record.get("ownerId") != current_user["id"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")

    await database[db.MEDIA].update_one(
        {"_id": record["_id"]},
        {"$set": {"status": "ready", "updatedAt": datetime.utcnow()}},
    )
    return {"success": True, "data": {"mediaId": mediaId, "status": "ready"}}


@router.get("/avatar-url")
async def create_avatar_url(
    mediaId: str = Query("", description="media record id of the avatar"),
    key: str = Query("", description="alternative: B2 object key of the avatar"),
    current_user: dict = Depends(get_current_user),
):
    """Return a short-lived GET URL for the *current user's* avatar media.

    Used by the frontend to refresh the persistent current-user avatar (which is
    cached across reloads) without embedding an expiring URL in the store. Only
    the owner of the media may resolve it; lists of other users receive avatars
    signed server-side via :func:`app.services.avatar.decorate_user_avatar`.
    """
    database = db.get_db()
    record = None
    if mediaId:
        if not ObjectId.is_valid(str(mediaId)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")
        record = await database[db.MEDIA].find_one({"_id": ObjectId(str(mediaId)), "deletedAt": None})
    elif key:
        object_key = sanitize_text(key, max_length=1024)
        if not object_key:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="key is required.")
        record = await database[db.MEDIA].find_one({"objectKey": object_key, "deletedAt": None})
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="mediaId or key is required.")

    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")
    if record.get("ownerId") != current_user["id"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access forbidden.")
    if record.get("status") != "ready":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Media is not ready.")

    try:
        result = storage.create_download_url(record["objectKey"], content_type=record.get("mime"))
    except storage.StorageUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except storage.StorageError as exc:
        logger.error(f"Avatar URL failure key={record['objectKey']!r}: {exc!s}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Storage is temporarily unavailable.")

    # This is the authorization boundary: the avatar's bytes are about to be
    # downloaded, so the object is "accessed" and shielded from expiry.
    await mark_media_accessed(database, record)

    return {
        "success": True,
        "data": {
            "url": result["downloadUrl"],
            "mediaId": str(record["_id"]),
            "expiresIn": result["expiresIn"],
        },
    }


@router.get("/download-url")
async def create_download_url(
    key: str = Query(..., description="B2 object key to authorize access to"),
    current_user: dict = Depends(get_current_user),
):
    """Authorize access to an object and return a short-lived presigned GET URL."""
    object_key = sanitize_text(key, max_length=1024)
    if not object_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="key is required.")

    database = db.get_db()
    record = await database[db.MEDIA].find_one({"objectKey": object_key, "deletedAt": None})
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")
    if record.get("ownerId") != current_user["id"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access forbidden.")

    try:
        result = storage.create_download_url(object_key, content_type=record.get("mime"))
    except storage.StorageUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except storage.StorageError as exc:
        logger.error(f"Download URL failure key={object_key!r}: {exc!s}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Storage is temporarily unavailable.")

    # Same authorization boundary as above: issuing the download URL proves the
    # object is being used, so it must not be considered "unused".
    await mark_media_accessed(database, record)

    return {
        "success": True,
        "data": {
            "url": result["downloadUrl"],
            "objectKey": object_key,
            "expiresIn": result["expiresIn"],
        },
    }


@router.delete("/")
async def delete_media(
    key: str = Body(..., embed=True),
    current_user: dict = Depends(get_current_user),
):
    """Authorize + delete an object owned by the current user.

    Respects the bucket's versioning behavior: the object is removed from B2
    and the media record is soft-deleted (deletedAt set) so history is kept.
    """
    object_key = sanitize_text(key, max_length=1024)
    if not object_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="key is required.")

    database = db.get_db()
    record = await database[db.MEDIA].find_one({"objectKey": object_key, "deletedAt": None})
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")
    if record.get("ownerId") != current_user["id"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access forbidden.")

    try:
        storage.delete_object(object_key)
    except storage.StorageUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except storage.StorageError as exc:
        logger.error(f"Delete failure key={object_key!r}: {exc!s}")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Storage is temporarily unavailable.")

    await database[db.MEDIA].update_one(
        {"_id": record["_id"]},
        {"$set": {"status": "deleted", "deletedAt": datetime.utcnow(), "updatedAt": datetime.utcnow()}},
    )
    return {"success": True, "data": {"objectKey": object_key, "status": "deleted"}}